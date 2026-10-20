import { assertGenerationInputBudget, freezeGenerationRequest, GENERATION_REQUEST_ENTRY, GENERATION_RESULT_ENTRY } from "../../generation/request";
import { GENERATION_STAGE_ENTRY, projectGenerationEntries } from "../../generation/projection";
import type { GenerationRequest, GenerationResult } from "../../generation/types";
import type { GenerationSourceAssessment } from "../../generation/sources";
import type { GenerationRuntimePort, GenerationStage, GenerationExecutionIdentity } from "../../generation/runtime";
import { freezePdfTaskRequest, pdfTaskRequestFromEntries } from "../../pdf-reading/task-context";
import type { PdfTaskRequest } from "../../pdf-reading/types";
import { normalizeEnglishDiarySourcePath, englishDiaryTaskContextFromEntries, type EnglishDiaryTaskContext } from "../../english-diary/task-context";
import type { TaskInterruptionReason, TaskInterruptionRecord, TaskResumeContext } from "../../agents/task-resume";
import { assertPiSubmissionActive } from "./pi-submission-lifecycle";
import { selectMemoryRecallPreviousUserContext } from "../memory/personal-memory-recall-harness";
import { KNOWLEDGE_SEARCH_KINDS, type KnowledgeSearchKind } from "../../knowledge-base/search/contracts";
import { knowledgePathRole, getKnowledgeFolderBindings } from "../../knowledge-base/root-paths";
import { normalizeConversationTaskMetadata, type ConversationTaskMetadata } from "../../agents/task-metadata";
import type { AgentRunSnapshot } from "../../agents/types";
import { knowledgeRolePath, resolveKnowledgePath } from "../../knowledge-base/root-paths";
import { knowledgeErrorDetail } from "../../knowledge-base/initialization-error";
import { maintenanceRequestsAdviceOnly } from "../../knowledge-base/wiki-folder-names";
import { normalizePiWorkspacePermission, piWorkspaceAllowsTool, type PiWorkspaceAccess } from "./pi-workspace-access";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  AgentSession,
  AgentSessionEvent,
  SessionEntry,
  SessionManager
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  clampThinkingLevel,
  type Api,
  type AssistantMessage,
  type ImageContent,
  type ThinkingContent,
  type Model,
  type ModelThinkingLevel
} from "@earendil-works/pi-ai";
import { assistantProviderFailureText, type AssistantProviderFailure, safeProviderFailureCode } from "../pi/provider-failure";
import {
  routeKnowledgeConversationCommand,
  type KnowledgeConversationCommand
} from "../../knowledge-base/commands";
import { KNOWLEDGE_REFERENCE_ENTRY_DETAILS_TYPE } from "../../knowledge-base/usage";
import { knowledgeMaintenanceEnvelopeFromToolResult } from "../../knowledge-base/knowledge-maintenance-result";
import { isRawMarkdownPath } from "../../knowledge-base/raw-digest";
import type { FileConversationCatalog } from "./file-conversation-catalog";
import type { FileProductRunStore } from "./file-product-run-store";
import {
  PiChatUiProjector,
  piEntryIdFromProjectedMessageId,
  projectSavedAnswerNotes,
  piKnowledgeToolDisplayMetadata,
  type PiChatUiMessageDecoration,
  type PiChatUiRunIdentity,
  type PiChatUiToolProductProjectionInput,
  type PiChatUiViewModel
} from "./pi-chat-ui-projector";
import { appendSavedAnswerNote } from "./pi-answer-save";
import { PI_MEMORY_SOURCES_ENTRY_TYPE, normalizeInjectedMemorySources, projectInjectedMemorySources } from "./pi-memory-sources";
import {
  PiSessionDurabilityError,
  assertPiSessionAppendsDurable,
  createDurablePiSession,
  createDurablePiSessionFromPrefix,
  discardCreatedDurablePiSession,
  inspectPiSessionJsonl,
  openDurablePiSession,
  persistPiActiveLeaf,
  readPiActiveLeafCheckpoint,
  type InvalidPiSessionJsonlInspection,
  type PiSessionDurabilityErrorCode,
  type PiSessionManagerApi,
  type ValidPiSessionJsonlInspection
} from "./pi-session-durability";
import type {
  ExperienceSourceRef,
  PiBranchNavigationResult,
  PiChatMode,
  PiChatEventSubscription,
  PiChatRunHandle,
  PiChatRuntimeEvent,
  PiChatRuntimeEventListener,
  PiChatNoteMention,
  PiChatPreparedDocument,
  PiChatSubmitRequest,
  PiChatPreparedImage,
  PiConversationCatalogEntry,
  PiConversationDerivationResult,
  PiConversationCatalogStatus,
  PiConversationDiagnostic,
  PiConversationDraftRecord,
  PiConversationMemoryMode,
  PiConversationProjection,
  PiKnowledgeObservation,
  PiKnowledgeMaintenanceScope,
  PiKnowledgeReference,
  PiKnowledgeRetrievalObservation,
  PiKnowledgeRuntimePort,
  PiMemoryRecallObservation,
  PiConversationSupportState,
  PiProductRunRecord,
  PiProductRunTerminalState,
  PiTaskPlanTransitionRequest,
  PiTaskPlanTransitionResult
} from "./contracts";
import { PI_IMAGE_INPUT_UNSUPPORTED_MESSAGE } from "./contracts";
import { normalizePiChatNoteMentions } from "./pi-note-mentions";
import { normalizeSelectionAnnotations } from "./pi-selection-annotations";
import { freezeWorkbenchTaskSource, workbenchTaskSourceFromEntries } from "../../home/workbench-context";
import type { WorkbenchTaskSource } from "../../home/workbench-types";
import type { SelectionAnnotation } from "../../types/selection-annotations";
import {
  normalizePiChatPreparedDocuments,
  preflightPiAnthropicDocumentRequest
} from "./pi-document-context";
import type { PersonalMemorySourceReference } from "../../settings/settings";
import { calculatePiEffectiveInputBudget, latestPiContextLedger } from "./pi-context-budget";
import {
  PI_KNOWLEDGE_MAINTAIN_TOOL_ID,
  type PiKnowledgeMaintenanceCommandContext
} from "./pi-knowledge-maintenance-tool";
import {
  ECHOINK_KNOWLEDGE_MAINTENANCE_PROTOCOL_VERSION
} from "../../knowledge-base/knowledge-maintenance-protocol";
import { PI_KNOWLEDGE_READ_TOOL_IDS } from "./pi-knowledge-read-tools";
import {
  piModelSupportsImageInput,
  type PiNativeProviderExecutionContext
} from "./pi-native-controlled-provider";
import {
  PiNativeFileStoreError,
  runtimeInterruptedDiagnosticId,
  type PiNativeFileStoreErrorCode
} from "./file-store-utils";
import {
  appendTaskPlanEntry,
  failTaskPlanForProductRun,
  pauseTaskPlanForRuntime,
  taskPlanSteeringSnapshot,
  transitionTaskPlanByUser
} from "./pi-task-plan";
import {
  activeTaskPlanFromBranch,
  latestTaskPlanFromBranch,
  taskPlanFromSessionEntry,
  taskPlanFromToolResult,
  taskPlanProgress,
  type EchoInkTaskPlanSnapshot
} from "../../types/task-plan";
import { resolveExplicitMemoryProjectId } from "../memory/project-identity";
import {
  appendReasoningSummaryEntry,
  cloneReasoningSummary,
  closeReasoningSummary,
  completeReasoningAtFirstText,
  createReasoningSummary,
  updateReasoningActivity
} from "./pi-reasoning-summary";
import type {
  EchoInkReasoningActivity,
  EchoInkReasoningActivityStatus,
  EchoInkReasoningSummarySnapshot,
  EchoInkReasoningSummaryStatus
} from "../../types/reasoning-summary";
import {
  cloneEchoInkAssistantTurn,
  type EchoInkAssistantTurnSnapshot,
  type EchoInkTurnInteraction,
  type EchoInkTurnInteractionRecord
} from "../../types/conversation-turn";
import { PI_USER_QUESTION_TOOL_ID } from "./pi-user-question-tool";
import { stableHashedIdentity as stableId } from "../../core/mapping";
import {
  isEchoInkReasoningEffort,
  isEchoInkPiReasoningEffortSupported,
  resolveEchoInkPiModelReasoningCapabilities
} from "../../settings/pi-model-catalog";
import type {
  DreamPublicExperienceInput,
  DreamTaskResultSummary
} from "../memory/dream-experience-inbox";

const BUILTIN_TOOL_NAMES = new Set([
  "bash",
  "edit",
  "find",
  "grep",
  "ls",
  "read",
  "write"
]);
const USER_ENTRY_WAIT_TIMEOUT_MS = 5_000;

type PiChatRuntimeMetadataKey =
  | "productRunId"
  | "conversationId"
  | "piSessionId"
  | "activeLeafId"
  | "occurredAt";

type PiProductRunStartFailureStage =
  | "user_entry_readback"
  | "draft_remove"
  | "product_run_create"
  | "product_run_mark_running";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, Extract<keyof T, K>>
  : never;

type PiChatRuntimeEventPayload = DistributiveOmit<
  PiChatRuntimeEvent,
  PiChatRuntimeMetadataKey
>;

export interface PiNativeAgentSessionFactoryInput {
  currentGenerationContext?(): { request: GenerationRequest; assessment: GenerationSourceAssessment } | null;
  providerSettingsId?: string;
  runtimeProviderId?: string;
  modelId?: string;
  catalog: Readonly<PiConversationCatalogEntry>;
  cwd: string;
  sessionManager: SessionManager;
  skillPath?: string;
  skillName?: string;
  skillPaths?: readonly string[];
  skillNames?: readonly string[];
  currentExecutionContext(): Readonly<PiNativeProviderExecutionContext>;
  currentToolExecutionContext(): Readonly<{
    conversationId: string;
    piSessionId: string;
    productRunId: string;
    vaultId: string;
    userEntryId: string;
    userEntryText: string;
  }>;
  currentWorkspaceAccess?(): Readonly<PiWorkspaceAccess> | null;
  currentTaskResumeContext?(): Readonly<TaskResumeContext> | undefined;
  currentWorkbenchSource?(): Readonly<WorkbenchTaskSource> | null;
  bindPdfDeliveryJob?(jobId: string): void;
  currentPdfTaskRequest?(): Readonly<PdfTaskRequest> | undefined;
  currentEnglishDiaryRequest?(): Readonly<EnglishDiaryTaskContext> | null;
  currentKnowledgeTurnContext(): Readonly<PiNativeKnowledgeTurnContext> | null;
  currentMaintenanceCommand?(): Promise<Readonly<PiKnowledgeMaintenanceCommandContext>>;
  currentSkillTurnContext?(): Readonly<PiNativeSkillTurnContext> | null;
  currentMemoryTurnContext?(): Readonly<PiNativeMemoryTurnContext> | null;
  currentSelectionAnnotationTurnContext?(): readonly SelectionAnnotation[];
  currentNoteMentionTurnContext?(): Readonly<PiNativeNoteMentionTurnContext> | null;
  currentDocumentTurnContext?(): Readonly<PiNativeDocumentTurnContext> | null;
  bindPdfMaintenanceSources?(paths: readonly string[]): void;
  consumePdfDocument?(attachmentId: string, sha256: string): Readonly<{ conversationId: string; userEntryId: string }> | null;
  currentTaskPlanTurnContext(): Readonly<PiNativeTaskPlanTurnContext> | null;
  /** Successful read-only external Tools from the currently bound ProductRun. */
  currentSuccessfulExternalReadToolNames(): readonly string[];
  reportInteractionRequested?(
    interaction: Readonly<EchoInkTurnInteraction>
  ): Promise<void>;
  reportInteractionResolved?(
    record: Readonly<EchoInkTurnInteractionRecord>
  ): Promise<void>;
  reportMemoryRecallProgress?(input: Readonly<{
    status: "active" | "completed";
    stage: "loading" | "catalog" | "matching" | "budgeting" | "assembling";
    elapsedMs: number;
    recall?: PiMemoryRecallObservation;
  }>): Promise<void>;
  /** Receives only primary Memory source metadata after Pi context insertion. */
  reportAskPersonalMemorySources?(input: Readonly<{
    productRunId: string;
    sources: readonly Readonly<PersonalMemorySourceReference>[];
  }>): Promise<void>;
  reportPersonalMemorySourcesInjected?(input: Readonly<{
    productRunId: string;
    sources: readonly Readonly<import("../../settings/settings").InjectedPersonalMemorySourceReference>[];
  }>): Promise<void>;
}

export interface PiNativeMemoryTurnContext {
  readonly vaultId: string;
  readonly conversationId: string;
  readonly piSessionId: string;
  readonly productRunId: string;
  readonly userEntryId?: string;
  readonly memoryMode: PiConversationMemoryMode;
  readonly projectId?: string;
  readonly query: string;
  readonly recentConversation?: readonly string[];
}

export interface PiNativeNoteMentionTurnContext {
  readonly noteMentions: readonly Readonly<PiChatNoteMention>[];
}

export interface PiNativeDocumentTurnContext {
  readonly documents: readonly Readonly<PiChatPreparedDocument>[];
}

export interface PiNativeSkillTurnContext {
  readonly skillId: string;
  readonly content: string;
}

export function shouldPreflightPersonalKnowledge(text: string, skillId?: string): boolean {
  // The bound journal Skill already contains the template. Retrieval stays available on request.
  if (skillId === "daily-journal" && !/(?:回看|查找|搜索|检索|之前|过去|旧|上次|笔记|资料|search|look\s*up|previous|notes)/iu.test(text)) return false;
  const normalized = text.normalize("NFKC").trim();
  if (!normalized) return false;
  if (/^(?:你好|嗨|哈喽|谢谢|收到|好的|ok|hello|hi|thanks)[!！,.，。?？\s]*$/iu.test(normalized)) {
    return false;
  }
  if (/^(?:请)?(?:把|将).{1,500}(?:翻译|改写|润色|校对|格式化)(?:成|为)?/iu.test(normalized)) {
    return false;
  }
  return !/^(?:请)?(?:翻译|改写|润色|校对|计算|格式化|translate|rewrite|proofread|calculate|format)(?:一下|下列|以下|这段|这个|\s|[:：])/iu.test(normalized);
}

const FAST_CHANGING_KNOWLEDGE = /(?:\bAI\b|人工智能|大模型|LLM|模型能力|API|SDK|软件|框架|版本|产品能力|价格|政策|法规|安全公告|漏洞)/iu;
const FRESHNESS_REVIEW_REQUEST = /(?:旧|还能用|仍可用|有效吗|过时|过期|时效|最新|当前|核验|查证|still\s+valid|outdated|obsolete|current|latest)/iu;
const FAST_KNOWLEDGE_STALE_AFTER_MS = 180 * 24 * 60 * 60 * 1_000;

export function knowledgeReferencesRequireFreshnessVerification(
  question: string,
  references: readonly Readonly<PiKnowledgeReference>[],
  now: number
): boolean {
  const explicitlyRequested = FRESHNESS_REVIEW_REQUEST.test(question.normalize("NFKC"));
  return references.some((reference) => {
    const subject = [
      reference.title,
      reference.vaultRelativePath,
      reference.excerpt
    ].join("\n");
    if (!FAST_CHANGING_KNOWLEDGE.test(subject)) return false;
    if (explicitlyRequested) return true;
    const publishedAt = reference.publishedAt
      ? Date.parse(reference.publishedAt)
      : Number.NaN;
    const observedAt = Number.isFinite(publishedAt)
      ? publishedAt
      : reference.recordedAt;
    if (observedAt === undefined || !Number.isFinite(observedAt)) return true;
    return now - observedAt >= FAST_KNOWLEDGE_STALE_AFTER_MS;
  });
}

export function resolvePiTurnToolNames(input: Readonly<{
  commandKind: "chat" | "ask" | "maintain";
  englishDiary?: boolean;
  permission?: PiWorkspaceAccess["permission"];
  mode: PiChatMode;
  memoryMode: PiConversationMemoryMode;
  defaultToolNames: readonly string[];
  memoryToolNames: readonly string[];
  planToolNames: readonly string[];
  externalReadToolNames?: readonly string[];
  requiresFreshnessVerification?: boolean;
}>): readonly string[] {
  const candidates = input.englishDiary ? (input.mode === "agent" ? input.defaultToolNames.filter(name => name === "english_diary_generate") : []) : input.mode === "plan" ? input.planToolNames : input.defaultToolNames;
  return [...new Set(candidates)].filter((toolName) => piWorkspaceAllowsTool({
    toolName,
    permission: normalizePiWorkspacePermission(input.permission),
    mode: input.mode,
    memoryMode: input.memoryMode,
    planToolNames: input.planToolNames,
    memoryToolNames: input.memoryToolNames,
    externalReadToolNames: input.externalReadToolNames ?? []
  }));
}

export interface PiNativeTaskPlanTurnContext {
  readonly mode: PiChatMode;
  readonly plan: Readonly<EchoInkTaskPlanSnapshot> | null;
}

export type PiNativeKnowledgeTurnContext =
  | Readonly<{
      kind: "chat";
      providerResourceText: string;
      references: readonly Readonly<PiKnowledgeReference>[];
    }>
  | Readonly<{
      kind: "ask";
      providerResourceText: string;
      references: readonly Readonly<PiKnowledgeReference>[];
    }>
  | Readonly<{
      kind: "maintain";
      command: Readonly<PiKnowledgeMaintenanceCommandContext>;
    }>;

export interface PiNativeAgentSessionFactoryResult {
  generationInputBudget?: number;
  /** Exact saved Provider used when activation selected the global default. */
  providerSettingsId?: string;
  session: AgentSession;
  /** Command-safe alias exposed by the controlled Pi ResourceLoader. */
  skillCommandName?: string;
  /** Fully expanded bodies of the exact routed Skill set. */
  skillPromptPrefix?: string;
  /** Read-only Vault/MCP Tools plus task_update; never inferred from copy. */
  planToolNames?: readonly string[];
  /** The fixed controlled long-term Memory Tool set, omitted in no_memory turns. */
  memoryToolNames?: readonly string[];
  /** Existing authorized read-only external Tools that `/ask` may use for freshness checks. */
  externalReadToolNames?: readonly string[];
  isToolCurrentlyEnabled?: (name: string) => boolean;
  warnings?: readonly string[];
}

export interface PiRuntimeSkillPort {
  selectForTask(
    input: Readonly<{ text: string; catalog?: Readonly<PiConversationCatalogEntry> }>
  ): Promise<Readonly<PiRuntimeResolvedSkill> | null>;
  resolveById?(
    input: Readonly<{ id: string; catalog?: Readonly<PiConversationCatalogEntry> }>
  ): Promise<Readonly<PiRuntimeResolvedSkill>>;
  recordUse(skillId: string, usedAt: number): Promise<void>;
  reviewCompletedTask(input: Readonly<{
    productRunId: string;
    request: string;
    result: string;
    terminalState: "completed" | "failed" | "cancelled";
    existingCapabilityIds: readonly string[];
  }>): Promise<unknown>;
}

export interface PiRuntimeResolvedSkill {
  readonly id: string;
  readonly skillPath: string;
  readonly skillName: string;
  readonly revision: string;
  readonly skills: readonly Readonly<{
    id: string;
    skillPath: string;
    skillName: string;
  }>[];
  readonly applicableSkillIds: readonly string[];
  readonly requiresFreshnessVerification: boolean;
}

export interface PiNativeConversationRuntimeOptions {
  generation?: GenerationRuntimePort;
  verifyPdfTaskDelivery?(request: Readonly<PdfTaskRequest> | string, noNewSourcePaths: readonly string[]): Promise<void>;
  resolveAgentRunSnapshot?: (catalog: Readonly<PiConversationCatalogEntry>) => AgentRunSnapshot;
  assertAgentActionAllowed?: (input: Readonly<{ catalog: Readonly<PiConversationCatalogEntry>; action: "knowledge-read" | "knowledge-write"; access?: Readonly<PiWorkspaceAccess> }>) => void | Promise<void>;
  catalog: FileConversationCatalog;
  productRuns: FileProductRunStore;
  sessionApi: PiSessionManagerApi;
  createAgentSession(
    input: PiNativeAgentSessionFactoryInput
  ): Promise<PiNativeAgentSessionFactoryResult>;
  resolveConversationCwd(conversationId: string): Promise<string> | string;
  hasPendingProductWork?(input: {
    conversationId: string;
    piSessionId: string;
    productRunId: string;
  }): Promise<boolean>;
  loadToolProductState?(input: {
    conversationId: string;
    piSessionId: string;
    productRunId?: string;
  }): Promise<Readonly<PiChatUiToolProductProjectionInput>>;
  loadKnowledgeDecorations?(input: {
    conversationId: string;
    piSessionId: string;
    entries: readonly SessionEntry[];
  }): Promise<readonly PiChatUiMessageDecoration[]>;
  /** Receives only public user/assistant text plus a minimal Tool outcome summary. */
  recordDreamExperience?(input: DreamPublicExperienceInput): Promise<void>;
  /** Product-owned Skill routing and independent post-task review. */
  skills?: PiRuntimeSkillPort;
  /** Disposes runtime-owned live resources before active sessions are released. */
  disposeRuntimeResources?(): void;
  knowledge?: PiKnowledgeRuntimePort;
  projector?: PiChatUiProjector;
  idFactory?: () => string;
  now?: () => number;
}

export interface ReadDurablePiConversationProjectionOptions {
  catalog: FileConversationCatalog;
  productRuns: FileProductRunStore;
  sessionApi: PiSessionManagerApi;
  conversationId: string;
  resolveConversationCwd(
    conversationId: string
  ): Promise<string> | string;
  loadToolProductState?: NonNullable<
    PiNativeConversationRuntimeOptions["loadToolProductState"]
  >;
  loadKnowledgeDecorations?: NonNullable<
    PiNativeConversationRuntimeOptions["loadKnowledgeDecorations"]
  >;
  projector?: PiChatUiProjector;
  now?: () => number;
}

export interface CreatePiNativeConversationInput extends ConversationTaskMetadata {
  conversationId: string;
  title: string;
  cwd: string;
  defaultMemoryMode?: PiConversationMemoryMode;
  defaultSkillId?: string;
  journalDirectory?: string;
  createdAt?: number;
}

export interface CreatePiConversationTransactionInput {
  catalog: FileConversationCatalog;
  sessionApi: PiSessionManagerApi;
  conversation: CreatePiNativeConversationInput;
  now?: () => number;
}

export async function createPiConversation(
  input: Readonly<CreatePiConversationTransactionInput>
): Promise<Readonly<PiConversationCatalogEntry>> {
  const { catalog, sessionApi, conversation } = input;
  const existing = await catalog.get(conversation.conversationId);
  if (existing) return existing;
  const createdAt = conversation.createdAt ?? (input.now ?? Date.now)();
  const durable = createDurablePiSession({
    api: sessionApi,
    sessionRoot: catalog.sessionRootPath,
    cwd: conversation.cwd
  });
  try {
    return await catalog.upsert({
      conversationId: conversation.conversationId,
      piSessionId: durable.piSessionId,
      vaultId: catalog.vaultId,
      title: conversation.title,
      ...normalizeConversationTaskMetadata(conversation),
      taskMetadataUpdatedAt: createdAt,
      status: "active",
      defaultMemoryMode: conversation.defaultMemoryMode ?? "normal",
      ...(conversation.defaultSkillId
        ? { defaultSkillId: conversation.defaultSkillId }
        : {}),
      ...(conversation.journalDirectory
        ? { journalDirectory: conversation.journalDirectory }
        : {}),
      createdAt,
      updatedAt: createdAt,
      sessionFile: durable.sessionFile
    });
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      await catalog.discardUnacceptedCreate({
        conversationId: conversation.conversationId,
        piSessionId: durable.piSessionId
      });
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      discardCreatedDurablePiSession({
        sessionRoot: catalog.sessionRootPath,
        sessionFile: durable.sessionFile,
        piSessionId: durable.piSessionId
      });
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "会话登记失败，且新建 Conversation 的回滚未完成"
      );
    }
    throw error;
  }
}

export interface DerivePiNativeConversationInput {
  sourceConversationId: string;
  targetConversationId: string;
  anchorEntryId: string;
  title: string;
  createdAt?: number;
}

export interface ActivatePiNativeConversationOptions {
  providerSettingsId?: string;
  runtimeProviderId?: string;
  modelId?: string;
  skillPath?: string;
  skillName?: string;
  skillPaths?: readonly string[];
  skillNames?: readonly string[];
  /** Runtime-only file revision used to invalidate a cached AgentSession. */
  skillRevision?: string;
}

export interface RecoverPiNativeConversationInput {
  conversationId: string;
  recoveryPath: string;
}

export interface PiNativeConversationRecoveryResult {
  catalog: Readonly<PiConversationCatalogEntry>;
  sourcePath: string;
  recoveryPath: string;
  recoveredEntryCount: number;
  activeLeafId: string | null;
}

export type PiNativeConversationRuntimeErrorCode =
  | "runtime_not_initialized"
  | "runtime_shutting_down"
  | "conversation_not_found"
  | "conversation_deleted"
  | "conversation_conflict"
  | "conversation_busy"
  | "conversation_derivation_invalid"
  | "draft_invalid"
  | "skill_binding_invalid"
  | "session_recovery_invalid"
  | "agent_session_invalid"
  | "image_input_unsupported"
  | "document_request_too_large"
  | "reasoning_level_invalid"
  | "product_run_start_failed_after_user_entry"
  | "agent_settled_missing"
  | "projection_unsettled"
  | "provider_execution_unbound";

export class PiNativeConversationRuntimeError extends Error {
  constructor(
    readonly code: PiNativeConversationRuntimeErrorCode,
    message: string,
    options?: ErrorOptions & {
      readonly piUserEntryAccepted?: boolean;
      readonly piUserEntryId?: string;
    }
  ) {
    super(message, options);
    this.name = "PiNativeConversationRuntimeError";
    this.piUserEntryAccepted = options?.piUserEntryAccepted === true;
    this.piUserEntryId = options?.piUserEntryId;
  }

  readonly piUserEntryAccepted: boolean;
  readonly piUserEntryId?: string;
}

const SAFE_PI_NATIVE_CONVERSATION_RUNTIME_ERROR_CODES:
ReadonlySet<string> = new Set<PiNativeConversationRuntimeErrorCode>([
  "runtime_not_initialized",
  "runtime_shutting_down",
  "conversation_not_found",
  "conversation_deleted",
  "conversation_conflict",
  "conversation_busy",
  "conversation_derivation_invalid",
  "draft_invalid",
  "skill_binding_invalid",
  "session_recovery_invalid",
  "agent_session_invalid",
  "image_input_unsupported",
  "document_request_too_large",
  "reasoning_level_invalid",
  "product_run_start_failed_after_user_entry",
  "agent_settled_missing",
  "projection_unsettled",
  "provider_execution_unbound"
]);

const SAFE_PI_SESSION_DURABILITY_ERROR_CODES:
ReadonlySet<string> = new Set<PiSessionDurabilityErrorCode>([
  "pi_session_api_incompatible",
  "pi_session_path_unsafe",
  "pi_session_jsonl_invalid",
  "pi_session_readback_mismatch",
  "pi_session_active_leaf_invalid"
]);

const SAFE_PI_NATIVE_FILE_STORE_ERROR_CODES:
ReadonlySet<string> = new Set<PiNativeFileStoreErrorCode>([
  "invalid-input",
  "mapping-conflict",
  "not-found",
  "invalid-transition",
  "store-corrupt",
  "readback-diverged"
]);

interface ActiveConversation {
  generationInputBudget?: number;
  lastPersistedLeafId: string | null;
  providerSettingsId?: string;
  catalog: Readonly<PiConversationCatalogEntry>;
  cwd: string;
  resourceKey: string;
  skillCommandName?: string;
  skillPromptPrefix?: string;
  defaultToolNames: readonly string[];
  planToolNames: readonly string[];
  memoryToolNames: readonly string[];
  externalReadToolNames: readonly string[];
  isToolCurrentlyEnabled?: (name: string) => boolean;
  registeredToolNames: ReadonlySet<string>;
  sessionManager: SessionManager;
  session: AgentSession;
  unsubscribe: () => void;
  currentExecution: PiNativeProviderExecutionContext | null;
  knowledgeTurnContext: Readonly<PiNativeKnowledgeTurnContext> | null;
  currentRun: ActiveProductRun | null;
  pendingSettlement: ActiveProductRun | null;
  eventLane: Promise<void>;
  queuePersistenceLane: Promise<void>;
  projection: PiChatUiViewModel;
}

interface ActiveProductRun {
  generation?: { request: GenerationRequest; assessment?: GenerationSourceAssessment; stage?: GenerationStage; previousAutoCompaction?: boolean; durable?: boolean; pendingEntries: { customType: string; data: unknown }[] };
  pdfTaskRequest?: Readonly<PdfTaskRequest>;
  pdfDeliveryJobs?: Set<string>;
  englishDiarySourcePath?: string;
  workbenchSource?: Readonly<WorkbenchTaskSource>;
  resumeContext?: TaskResumeContext;
  interruption?: TaskInterruptionRecord;
  productRunId: string;
  submittedAt: number;
  baselineEntryIds: ReadonlySet<string>;
  messageKeys: Map<string, string>;
  messageSequence: number;
  toolCallIds: Set<string>;
  agentSettledSeen: boolean;
  abortRequested: boolean;
  knowledgeAbort: AbortController;
  releaseSubmissionAbort?: () => void;
  eventError: unknown;
  channel: PiRuntimeEventChannel;
  settlementBarrier: PiProductRunSettlementBarrier;
  requestText: string;
  commandKind: "chat" | "ask" | "maintain";
  englishDiary?: boolean;
  selectedSkillIds: readonly string[];
  requiresFreshnessVerification: boolean;
  successfulCapabilityIds: Set<string>;
  projectId?: string;
  mode: PiChatMode;
  memoryMode: PiConversationMemoryMode;
  permission: PiWorkspaceAccess["permission"];
  maintenanceScope?: PiChatSubmitRequest["maintenanceScope"];
  noteMentions: readonly Readonly<PiChatNoteMention>[];
  selectionAnnotations: readonly SelectionAnnotation[];
  documents: readonly Readonly<PiChatPreparedDocument>[];
  skillTurnContext: Readonly<PiNativeSkillTurnContext> | null;
  memoryRecall?: PiMemoryRecallObservation;
  providerStartedAt?: number;
  providerWaitTimer?: ReturnType<typeof setInterval>;
  firstAssistantTextSeen: boolean;
  providerReasoningBlocks: Map<string, MutableProviderReasoningBlock>;
  providerReasoningExposedMessageKeys: Set<string>;
  reasoningSummary: Readonly<EchoInkReasoningSummarySnapshot>;
  reasoningStartEntryId?: string;
  reasoningTerminalEntryId?: string;
  knowledgeProgressDepth: Map<Extract<
    PiChatRuntimeEvent,
    { type: "knowledge_progress" }
  >["stage"], number>;
  knowledgeToolStages: Map<string, Extract<
    PiChatRuntimeEvent,
    { type: "knowledge_progress" }
  >["stage"]>;
  knowledgeObservation: MutablePiKnowledgeObservation | null;
  knowledgeWorkflow:
    | null
    | {
        kind: "chat";
        references: readonly Readonly<PiKnowledgeReference>[];
        bufferedAssistantEvents: PiChatRuntimeEventPayload[];
      }
    | {
        kind: "ask";
        references: readonly Readonly<PiKnowledgeReference>[];
        personalMemorySources: readonly Readonly<PersonalMemorySourceReference>[];
        bufferedAssistantEvents: PiChatRuntimeEventPayload[];
      }
    | {
        kind: "maintain";
        command: Readonly<PiKnowledgeMaintenanceCommandContext>;
      };
}

interface MutableProviderReasoningBlock {
  readonly messageKey: string;
  readonly contentIndex: number;
  readonly reasoningId: string;
  startedAt: number;
  readonly messageTimestamp?: number;
  text: string;
  exposed: boolean;
  redacted: boolean;
}

interface MutablePiKnowledgeObservation {
  workflow: PiKnowledgeObservation["workflow"];
  localRetrievalElapsedMs: number;
  candidates: number;
  returned: number;
  remaining: number;
  hasMore: boolean;
  exhausted: boolean;
  continuationCount: number;
  knowledgeReadCount: number;
  memoryRecallUsed: boolean;
  memorySearchUsed: boolean;
  memoryReadUsed: boolean;
  conflictOrFreshnessTriggered: boolean;
  modelFirstTextLatencyMs?: number;
  protocolVersion?: string;
  preferenceProfileVersion?: string;
  preferenceState?: "default" | "custom";
}

interface PiProductRunSettlementBarrier {
  readonly promise: Promise<void>;
  resolve(): void;
}

class PiRuntimeEventChannel {
  readonly events: PiChatRuntimeEvent[] = [];
  private readonly subscribers = new Set<{
    listener: PiChatRuntimeEventListener;
    lane: Promise<void>;
    closed: boolean;
  }>();

  async emit(event: Readonly<PiChatRuntimeEvent>): Promise<void> {
    const captured = structuredClone(event) as PiChatRuntimeEvent;
    this.events.push(captured);
    const deliveries: Promise<void>[] = [];
    for (const subscriber of this.subscribers) {
      if (subscriber.closed) continue;
      subscriber.lane = subscriber.lane
        .then(async () => {
          if (!subscriber.closed) {
            await subscriber.listener(structuredClone(captured));
          }
        })
        .catch(() => undefined);
      deliveries.push(subscriber.lane);
    }
    await Promise.all(deliveries);
  }

  subscribe(listener: PiChatRuntimeEventListener): PiChatEventSubscription {
    if (typeof listener !== "function") {
      throw new TypeError("Pi Chat runtime event listener is required");
    }
    const state = {
      listener,
      lane: Promise.resolve(),
      closed: false
    };
    for (const event of this.events) {
      state.lane = state.lane
        .then(async () => {
          if (!state.closed) await listener(structuredClone(event));
        })
        .catch(() => undefined);
    }
    this.subscribers.add(state);
    return Object.freeze({
      unsubscribe: () => {
        state.closed = true;
        this.subscribers.delete(state);
      }
    });
  }
}

/**
 * One Pi Session per EchoInk Conversation, with AgentSession as the only model
 * and Tool loop. The Catalog and ProductRun stores contain identities only;
 * every chat body remains in the Pi JSONL.
 */
export class PiNativeConversationRuntime {
  private readonly catalog: FileConversationCatalog;
  private readonly productRuns: FileProductRunStore;
  private readonly projector: PiChatUiProjector;
  private readonly idFactory: () => string;
  private readonly now: () => number;
  private readonly active = new Map<string, ActiveConversation>();
  private readonly submitting = new Set<string>();
  private readonly activating = new Map<string, Promise<unknown>>();
  private readonly runChannels = new Map<string, PiRuntimeEventChannel>();
  private readonly recoveringConversations = new Set<string>();
  private initialized = false;
  private shuttingDown = false;

  constructor(private readonly options: PiNativeConversationRuntimeOptions) {
    this.catalog = options.catalog;
    this.productRuns = options.productRuns;
    this.projector = options.projector ?? new PiChatUiProjector();
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? Date.now;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.catalog.initialize();
    await this.productRuns.initialize();
    this.initialized = true;
  }

  async createConversation(
    input: CreatePiNativeConversationInput
  ): Promise<Readonly<PiConversationCatalogEntry>> {
    this.assertReady();
    return await createPiConversation({
      catalog: this.catalog,
      sessionApi: this.options.sessionApi,
      conversation: input,
      now: this.now
    });
  }

  async deriveConversation(
    input: DerivePiNativeConversationInput
  ): Promise<Readonly<PiConversationDerivationResult>> {
    this.assertReady();
    const sourceConversationId = requireNonEmptyRuntimeString(
      input.sourceConversationId,
      "sourceConversationId"
    );
    const targetConversationId = requireNonEmptyRuntimeString(
      input.targetConversationId,
      "targetConversationId"
    );
    const anchorEntryId = requireNonEmptyRuntimeString(
      input.anchorEntryId,
      "anchorEntryId"
    );
    const title = requireNonEmptyRuntimeString(input.title, "title");
    if (sourceConversationId === targetConversationId) {
      throw new PiNativeConversationRuntimeError(
        "conversation_conflict",
        "派生会话必须使用独立的 Conversation 身份"
      );
    }
    if (await this.catalog.get(targetConversationId)) {
      throw new PiNativeConversationRuntimeError(
        "conversation_conflict",
        `Conversation ${targetConversationId} 已存在`
      );
    }

    const source = await this.requireActiveConversation(sourceConversationId);
    if (
      source.currentRun
      || source.pendingSettlement
      || source.session.isStreaming
    ) {
      throw new PiNativeConversationRuntimeError(
        "conversation_busy",
        "运行期间不能从消息新建会话"
      );
    }
    if (!source.catalog.sessionFile) {
      throw new PiNativeConversationRuntimeError(
        "conversation_derivation_invalid",
        "源 Conversation 没有可验证的 Pi Session 文件"
      );
    }

    const sourceBranch = source.sessionManager.getBranch();
    const anchorIndex = sourceBranch.findIndex(
      (entry) => entry.id === anchorEntryId
    );
    const anchor = sourceBranch[anchorIndex];
    if (
      !anchor
      || anchor.type !== "message"
      || (anchor.message.role !== "user" && anchor.message.role !== "assistant")
    ) {
      throw new PiNativeConversationRuntimeError(
        "conversation_derivation_invalid",
        "只能从当前路线中的用户提问或助手回复新建会话"
      );
    }
    const anchorRole = anchor.message.role;
    const sourceLeafId = anchorRole === "user"
      ? sourceBranch[anchorIndex - 1]?.id ?? null
      : anchor.id;
    const editorText = anchorRole === "user"
      ? editorTextFromUserMessage(anchor.message)
      : "";
    const durable = createDurablePiSessionFromPrefix({
      api: this.options.sessionApi,
      sessionRoot: this.catalog.sessionRootPath,
      sourceSessionFile: source.catalog.sessionFile,
      sourceLeafId,
      cwd: source.cwd
    });
    const createdAt = input.createdAt ?? this.now();

    let derivedCatalog: Readonly<PiConversationCatalogEntry>;
    try {
      derivedCatalog = await this.catalog.upsert({
        conversationId: targetConversationId,
        piSessionId: durable.piSessionId,
        vaultId: this.catalog.vaultId,
        title,
        agentId: source.catalog.agentId,
        taskMetadataUpdatedAt: createdAt,
        status: "active",
        defaultMemoryMode: source.catalog.defaultMemoryMode,
        ...(source.catalog.defaultSkillId
          ? { defaultSkillId: source.catalog.defaultSkillId }
          : {}),
        ...(source.catalog.journalDirectory
          ? { journalDirectory: source.catalog.journalDirectory }
          : {}),
        createdAt,
        updatedAt: createdAt,
        sessionFile: durable.sessionFile
      });
    } catch (error) {
      try {
        discardCreatedDurablePiSession({
          sessionRoot: this.catalog.sessionRootPath,
          sessionFile: durable.sessionFile,
          piSessionId: durable.piSessionId
        });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "派生会话登记失败，且新 Pi Session 回滚未完成"
        );
      }
      throw error;
    }

    let projection: PiConversationProjection;
    let activation: PiConversationDerivationResult["activation"];
    try {
      projection = await this.switchConversation(
        sourceConversationId,
        derivedCatalog.conversationId
      );
      activation = Object.freeze({ status: "activated" });
    } catch (error) {
      // Catalog and JSONL are already committed. Treat this as a successful
      // creation with a recoverable activation failure so the UI and a fresh
      // runtime observe the same formal Conversation instead of a ghost.
      projection = await this.readProjection(derivedCatalog.conversationId);
      activation = Object.freeze({
        status: "failed",
        message: safeRuntimeErrorText(error)
      });
    }
    return Object.freeze({
      sourceConversationId,
      anchorEntryId,
      anchorRole,
      editorText,
      activation,
      projection
    });
  }

  async listConversations(
    statuses?: readonly PiConversationCatalogStatus[]
  ): Promise<Readonly<PiConversationCatalogEntry>[]> {
    this.assertReady();
    return await this.catalog.list(statuses ? { statuses } : {});
  }

  async getConversation(
    conversationId: string
  ): Promise<Readonly<PiConversationCatalogEntry> | null> {
    this.assertReady();
    return await this.catalog.get(conversationId);
  }

  async readConversationSupportState(
    conversationId: string
  ): Promise<PiConversationSupportState> {
    this.assertReady();
    const catalog = await this.requireCatalogConversation(conversationId);
    return {
      catalog,
      diagnostics: [
        ...(await this.catalog.diagnostics(conversationId))
      ],
      drafts: [
        ...(await this.catalog.drafts(conversationId))
      ]
    };
  }

  async discardDraft(
    conversationId: string,
    draftId: string
  ): Promise<boolean> {
    this.assertReady();
    this.assertConversationNotRecovering(conversationId);
    const catalog = await this.requireCatalogConversation(conversationId);
    const normalizedDraftId = requireNonEmptyRuntimeString(
      draftId,
      "draftId"
    );
    const draft = (await this.catalog.drafts(conversationId)).find(
      (candidate) => candidate.draftId === normalizedDraftId
    );
    if (!draft) return false;
    assertDraftIdentity(draft, catalog);
    return await this.catalog.removeDraft(normalizedDraftId);
  }

  /**
   * Resolve a settled ProductRun to the pointer-only Phase 4 source contract.
   *
   * `no_memory` ProductRuns never publish an Experience source. Missing,
   * unsettled, identity-mismatched, deleted, or no-memory sources fail closed.
   */
  async readExperienceSourceRef(
    productRunId: string
  ): Promise<Readonly<ExperienceSourceRef> | null> {
    this.assertReady();
    const run = await this.productRuns.read(productRunId);
    if (
      !run
      || run.state !== "product_run_settled"
      || !run.terminalState
      || run.memoryMode === "no_memory"
    ) {
      return null;
    }
    const catalog = await this.catalog.get(run.conversationId);
    if (
      !catalog
      || catalog.status === "deleted"
      || catalog.vaultId !== this.catalog.vaultId
      || catalog.vaultId !== this.productRuns.vaultId
      || catalog.piSessionId !== run.piSessionId
    ) {
      return null;
    }
    return Object.freeze({
      sourceEventId: stableId(
        "experience-source",
        catalog.vaultId,
        run.conversationId,
        run.piSessionId,
        run.productRunId,
        run.userEntryId,
        run.assistantEntryId ?? "",
        run.terminalState
      ),
      vaultId: catalog.vaultId,
      conversationId: run.conversationId,
      piSessionId: run.piSessionId,
      userEntryId: run.userEntryId,
      ...(run.assistantEntryId
        ? { assistantEntryId: run.assistantEntryId }
        : {}),
      productRunId: run.productRunId,
      memoryMode: run.memoryMode,
      terminalState: run.terminalState
    });
  }

  async renameConversation(
    conversationId: string,
    title: string
  ): Promise<Readonly<PiConversationCatalogEntry>> {
    this.assertReady();
    const updated = await this.catalog.rename(
      conversationId,
      title,
      this.now()
    );
    const active = this.active.get(conversationId);
    if (active) active.catalog = updated;
    return updated;
  }

  async setConversationMemoryMode(
    conversationId: string,
    defaultMemoryMode: PiConversationMemoryMode
  ): Promise<Readonly<PiConversationCatalogEntry>> {
    this.assertReady();
    const catalog = await this.requireCatalogConversation(conversationId);
    const updated = await this.catalog.upsert({
      ...catalog,
      defaultMemoryMode,
      updatedAt: this.now()
    });
    const active = this.active.get(conversationId);
    if (active) active.catalog = updated;
    return updated;
  }

  async setConversationTaskMetadata(
    conversationId: string,
    metadata: ConversationTaskMetadata,
    expectedRevision: number | undefined,
    updatedAt = this.now()
  ): Promise<Readonly<PiConversationCatalogEntry>> {
    this.assertReady();
    const updated = await this.catalog.updateTaskMetadata(conversationId, metadata, expectedRevision, updatedAt);
    const active = this.active.get(conversationId);
    if (active) active.catalog = updated;
    return updated;
  }

  async setConversationStatus(
    conversationId: string,
    status: PiConversationCatalogStatus
  ): Promise<Readonly<PiConversationCatalogEntry>> {
    this.assertReady();
    if (status !== "active") await this.releaseConversation(conversationId);
    const updated = await this.catalog.status(conversationId, status, this.now());
    return updated;
  }

  async activateConversation(
    conversationId: string,
    options: ActivatePiNativeConversationOptions = {}
  ): Promise<PiConversationProjection> {
    const active = await this.requireActiveConversation(
      conversationId,
      options
    );
    return await this.projectionFromActive(active);
  }

  async switchConversation(
    previousConversationId: string | null,
    nextConversationId: string,
    options: ActivatePiNativeConversationOptions = {}
  ): Promise<PiConversationProjection> {
    const projection = await this.activateConversation(
      nextConversationId,
      options
    );
    if (
      previousConversationId
      && previousConversationId !== nextConversationId
    ) {
      await this.releaseConversationIfIdle(previousConversationId);
    }
    return projection;
  }

  async recoverConversationFromVerifiedPrefix(
    input: Readonly<RecoverPiNativeConversationInput>
  ): Promise<Readonly<PiNativeConversationRecoveryResult>> {
    this.assertReady();
    const conversationId = requireNonEmptyRuntimeString(
      input.conversationId,
      "conversationId"
    );
    const recoveryPath = requireNonEmptyRuntimeString(
      input.recoveryPath,
      "recoveryPath"
    );
    if (this.recoveringConversations.has(conversationId)) {
      throw new PiNativeConversationRuntimeError(
        "conversation_busy",
        `Conversation ${conversationId} 正在恢复 Pi Session`
      );
    }
    this.recoveringConversations.add(conversationId);
    try {
      const active = this.active.get(conversationId);
      if (
        active?.currentRun
        || active?.pendingSettlement
        || active?.session.isStreaming
      ) {
        throw new PiNativeConversationRuntimeError(
          "conversation_busy",
          `Conversation ${conversationId} 有活动写者，不能恢复 Pi Session`
        );
      }
      if (active) await this.releaseConversation(conversationId);

      const catalog = await this.requireCatalogConversation(conversationId);
      if (catalog.status === "deleted") {
        throw new PiNativeConversationRuntimeError(
          "conversation_deleted",
          `Conversation ${conversationId} 已删除`
        );
      }
      if (!catalog.sessionFile) {
        throw new PiNativeConversationRuntimeError(
          "session_recovery_invalid",
          `Conversation ${conversationId} 没有可恢复的 Pi Session 文件`
        );
      }

      const sourceInspection = inspectRecoveryCandidate(
        this.catalog.sessionRootPath,
        catalog.sessionFile,
        "corrupt source"
      );
      if (sourceInspection.valid || !sourceInspection.header) {
        throw new PiNativeConversationRuntimeError(
          "session_recovery_invalid",
          "Verified-prefix recovery requires a corrupt source with a valid Pi Session header"
        );
      }
      if (sourceInspection.header.id !== catalog.piSessionId) {
        throw new PiNativeConversationRuntimeError(
          "session_recovery_invalid",
          "The corrupt source Pi Session identity does not match the Conversation Catalog"
        );
      }

      const recoveryInspection = inspectRecoveryCandidate(
        this.catalog.sessionRootPath,
        recoveryPath,
        "verified recovery"
      );
      if (!recoveryInspection.valid) {
        throw new PiNativeConversationRuntimeError(
          "session_recovery_invalid",
          "The proposed Pi Session recovery file failed strict JSONL validation"
        );
      }
      if (recoveryInspection.header.id !== catalog.piSessionId) {
        throw new PiNativeConversationRuntimeError(
          "session_recovery_invalid",
          "The proposed recovery belongs to a different Pi Session"
        );
      }

      const diagnostics = await this.catalog.diagnostics(conversationId);
      const generatedByDurabilityAdapter = diagnostics.some((diagnostic) =>
        diagnostic.code === "session_recovered_prefix"
        && diagnostic.sourcePath === sourceInspection.sourcePath
        && diagnostic.recoveryPath === recoveryInspection.sourcePath
      );
      if (!generatedByDurabilityAdapter) {
        throw new PiNativeConversationRuntimeError(
          "session_recovery_invalid",
          "The proposed recovery was not generated by the Pi Session durability adapter"
        );
      }
      assertExactVerifiedRecoveryPrefix(
        sourceInspection,
        recoveryInspection
      );

      const cwd = await this.options.resolveConversationCwd(conversationId);
      const reopened = openDurablePiSession({
        api: this.options.sessionApi,
        sessionRoot: this.catalog.sessionRootPath,
        sessionFile: recoveryInspection.sourcePath,
        cwd,
        createRecoveryOnCorruption: false
      });
      if (reopened.piSessionId !== catalog.piSessionId) {
        throw new PiNativeConversationRuntimeError(
          "session_recovery_invalid",
          "The reopened recovery Pi Session identity changed during validation"
        );
      }

      const rebound = await this.catalog.adoptVerifiedRecoverySessionFile({
        conversationId,
        piSessionId: catalog.piSessionId,
        expectedSessionFile: sourceInspection.sourcePath,
        recoverySessionFile: recoveryInspection.sourcePath,
        updatedAt: this.now()
      });
      return Object.freeze({
        catalog: rebound,
        sourcePath: sourceInspection.sourcePath,
        recoveryPath: recoveryInspection.sourcePath,
        recoveredEntryCount: recoveryInspection.entries.length,
        activeLeafId: reopened.restoredActiveLeafId
      });
    } finally {
      this.recoveringConversations.delete(conversationId);
    }
  }

  async submit(
    request: Readonly<PiChatSubmitRequest>
  ): Promise<PiChatRunHandle> {
    this.assertReady();
    assertPiSubmissionActive(request.signal);
    if (this.submitting.has(request.conversationId)) {
      throw new PiNativeConversationRuntimeError(
        "conversation_busy",
        `Conversation ${request.conversationId} 正在启动 ProductRun`
      );
    }
    this.submitting.add(request.conversationId);
    try {
      const workbenchSource = freezeWorkbenchTaskSource(request.workbenchSource);
      return await this.submitPrepared(Object.freeze({ ...request, workbenchSource: workbenchSource ?? undefined, permission: normalizePiWorkspacePermission(request.permission) }));
    } finally {
      this.submitting.delete(request.conversationId);
    }
  }

  private async submitPrepared(
    request: Readonly<PiChatSubmitRequest>
  ): Promise<PiChatRunHandle> {
    assertPiSubmissionActive(request.signal);
    this.assertConversationNotRecovering(request.conversationId);
    assertValidSkillBinding(request);
    const promptImages = normalizePiChatPreparedImages(request.images);
    const noteMentions = normalizePiChatNoteMentions(request.noteMentions);
    const selectionAnnotations = normalizeSelectionAnnotations(request.selectionAnnotations);
    const documents = normalizePiChatPreparedDocuments(request.documents);
    const mode = normalizePiChatMode(request.mode);
    const permission = normalizePiWorkspacePermission(request.permission);
    let catalog = await this.catalog.get(request.conversationId);
    if (!catalog) {
      const cwd = await this.options.resolveConversationCwd(
        request.conversationId
      );
      catalog = await this.createConversation({
        conversationId: request.conversationId,
        title: "新会话",
        cwd,
        defaultMemoryMode: request.memoryMode ?? "normal",
        createdAt: request.submittedAt
      });
    }
    if (catalog.status === "deleted") {
      throw new PiNativeConversationRuntimeError(
        "conversation_deleted",
        `Conversation ${request.conversationId} 已删除`
      );
    }
    if (catalog.status === "archived") {
      catalog = await this.catalog.status(
        catalog.conversationId,
        "active",
        this.now()
      );
    }

    assertPiSubmissionActive(request.signal);
    const selectedDraft = request.draftId
      ? await this.requireDraftForSubmission(catalog, request.draftId)
      : null;

    const knowledgeCommand: KnowledgeConversationCommand =
      request.generationRequest || mode === "plan" || !this.options.knowledge
        ? Object.freeze({ kind: "chat", originalText: request.text })
        : routeKnowledgeConversationCommand(request.text);

    const selectedRuntimeSkill = !request.generationRequest && !request.pdfTaskRequest && !request.englishDiarySourcePath && !request.skillPath
      ? catalog.defaultSkillId
        ? await this.resolveConversationDefaultSkill(catalog.defaultSkillId, catalog)
        : mode !== "plan"
          ? await this.options.skills?.selectForTask({ text: request.text, catalog }) ?? null
          : null
      : null;
    const selectedRuntimeSkills = selectedRuntimeSkill
      ? selectedRuntimeSkill.skills?.length
        ? selectedRuntimeSkill.skills
        : Object.freeze([Object.freeze({
            id: selectedRuntimeSkill.id,
            skillPath: selectedRuntimeSkill.skillPath,
            skillName: selectedRuntimeSkill.skillName
          })])
      : Object.freeze([]);

    assertPiSubmissionActive(request.signal);
    if (request.resumeContext) await this.prepareTaskResumeBranch(catalog, request.resumeContext, request.signal);
    const active = await this.requireActiveConversation(
      request.conversationId,
      {
        providerSettingsId: request.providerSettingsId,
        runtimeProviderId: request.runtimeProviderId,
        modelId: request.modelId,
        ...(request.skillPath
          ? { skillPath: request.skillPath, skillName: request.skillName }
          : selectedRuntimeSkill
            ? {
                skillPaths: selectedRuntimeSkills.map((skill) => skill.skillPath),
                skillNames: selectedRuntimeSkills.map((skill) => skill.skillName),
                skillRevision: selectedRuntimeSkill.revision
              }
            : {})
      }
    );
    assertPiSubmissionActive(request.signal);
    if (active.currentRun || active.session.isStreaming) {
      throw new PiNativeConversationRuntimeError(
        "conversation_busy",
        `Conversation ${request.conversationId} 已有运行中的 ProductRun`
      );
    }
    const inheritedPdf = pdfTaskRequestFromEntries(active.sessionManager.getBranch());
    const pdfTaskRequest = request.pdfTaskRequest ? freezePdfTaskRequest(request.pdfTaskRequest) : inheritedPdf;
    if (request.pdfTaskRequest && (!pdfTaskRequest || inheritedPdf && JSON.stringify(inheritedPdf) !== JSON.stringify(pdfTaskRequest))) throw new PiNativeConversationRuntimeError("agent_session_invalid", "PDF任务的文件和成果已固定，请从PDF页另建任务。");
    if (request.pdfTaskRequest && !inheritedPdf && active.sessionManager.getBranch().some(entry => entry.type === "message")) throw new PiNativeConversationRuntimeError("agent_session_invalid", "请从PDF页新建独立任务。");
    if (request.pdfTaskRequest && (documents.length !== 1 || documents[0].transport !== "tool_reference" || documents[0].attachmentId !== pdfTaskRequest!.attachmentId || documents[0].sha256 !== pdfTaskRequest!.sourceFingerprint || documents[0].bytes.length !== pdfTaskRequest!.byteLength || promptImages.length || noteMentions.length || selectionAnnotations.length || request.skillPath)) throw new PiNativeConversationRuntimeError("agent_session_invalid", "PDF任务的附件与本次选择不一致，未发送。");
    if (pdfTaskRequest && (mode === "plan" || permission === "read-only")) throw new PiNativeConversationRuntimeError("agent_session_invalid", "处理PDF需要可写工作区和Agent模式，请调整对话栏权限后重试。");
    const inheritedEnglish = englishDiaryTaskContextFromEntries(active.sessionManager.getBranch());
    const englishDiarySourcePath = normalizeEnglishDiarySourcePath(request.englishDiarySourcePath) ?? inheritedEnglish?.sourcePath;
    if (request.englishDiarySourcePath && inheritedEnglish && request.englishDiarySourcePath !== inheritedEnglish.sourcePath) throw new PiNativeConversationRuntimeError("agent_session_invalid", "这件任务的原稿范围已固定，请从列表另建一件事。");
    if (request.englishDiarySourcePath && !inheritedEnglish && active.sessionManager.getBranch().some(entry => entry.type === "message")) throw new PiNativeConversationRuntimeError("agent_session_invalid", "请从英文日记页新建独立任务，避免把原有会话内容带入生成。");
    if (request.englishDiarySourcePath && !normalizeEnglishDiarySourcePath(request.englishDiarySourcePath)) throw new PiNativeConversationRuntimeError("agent_session_invalid", "英文日记原稿位置无效，请从英文日记页重新选择。");
    if (englishDiarySourcePath && (mode === "plan" || permission === "read-only")) throw new PiNativeConversationRuntimeError("agent_session_invalid", "生成英文日记需要可写工作区和 Agent 模式；原稿已保留。");
    if (englishDiarySourcePath && (documents.length || promptImages.length || noteMentions.length || selectionAnnotations.length || request.skillPath)) throw new PiNativeConversationRuntimeError("agent_session_invalid", "英文日记任务沿已确认的发送范围处理，请移除额外附件、引用和 Skill 后再发送。");
    if (knowledgeCommand.kind === "maintain" && promptImages.length) {
      throw new PiNativeConversationRuntimeError(
        "agent_session_invalid",
        "/maintain 不接受图片输入。"
      );
    }
    if (knowledgeCommand.kind === "maintain" && documents.length) {
      throw new PiNativeConversationRuntimeError(
        "agent_session_invalid",
        "/maintain 不接受普通 Pi 文档上下文。"
      );
    }
    if (promptImages.length && !agentSessionSupportsImageInput(active.session)) {
      throw new PiNativeConversationRuntimeError(
        "image_input_unsupported",
        PI_IMAGE_INPUT_UNSUPPORTED_MESSAGE
      );
    }
    assertPiChatSubmitModelIdentity(active.session, request);
    const requestedThinkingLevel = validatedPiThinkingLevel(
      active.session.model,
      request.reasoning
    );
    const documentRequestPreflight = preflightPiAnthropicDocumentRequest({
      documents,
      images: [
        ...piInlineImagesInMessages(active.session.messages),
        ...promptImages
      ],
      contextWindow: active.session.model?.contextWindow ?? 0
    });
    if (documentRequestPreflight.exceedsLimit) {
      throw new PiNativeConversationRuntimeError(
        "document_request_too_large",
        "文档与图片的原生请求可能超过 Anthropic 32 MiB 限制；本轮未发送，请减少附件后重试。"
      );
    }

    const productRunId = this.nextId("product-run");
    const memoryMode = request.generationRequest ? "no_memory" : request.memoryMode ?? catalog.defaultMemoryMode;
    const projectId = resolveExplicitMemoryProjectId(request.text);
    const channel = new PiRuntimeEventChannel();
    this.runChannels.set(productRunId, channel);
    const selectedSkillIds = Object.freeze(selectedRuntimeSkill
      ? selectedRuntimeSkills.map((skill) => skill.id)
      : request.skillId?.trim()
        ? [request.skillId.trim()]
        : request.skillName ? [request.skillName] : []);
    const execution: ActiveProductRun = {
      ...(request.generationRequest ? { generation: { request: freezeGenerationRequest(request.generationRequest), pendingEntries: [] } } : {}),
      ...(pdfTaskRequest ? { pdfTaskRequest } : {}),
      ...(englishDiarySourcePath ? { englishDiarySourcePath } : {}),
      ...(request.workbenchSource ? { workbenchSource: request.workbenchSource } : {}),
      ...(request.resumeContext ? { resumeContext: structuredClone(request.resumeContext) } : {}),
      productRunId,
      submittedAt: request.submittedAt,
      baselineEntryIds: new Set(
        active.sessionManager.getEntries().map((entry) => entry.id)
      ),
      messageKeys: new Map(),
      messageSequence: 0,
      toolCallIds: new Set(),
      agentSettledSeen: false,
      abortRequested: false,
      knowledgeAbort: new AbortController(),
      eventError: null,
      channel,
      settlementBarrier: createSettlementBarrier(),
      requestText: request.text,
      commandKind: knowledgeCommand.kind,
      selectedSkillIds,
      requiresFreshnessVerification:
        selectedRuntimeSkill?.requiresFreshnessVerification === true,
      successfulCapabilityIds: new Set<string>(),
      ...(projectId ? { projectId } : {}),
      mode,
      memoryMode,
      permission,
      maintenanceScope: request.maintenanceScope,
      noteMentions,
      selectionAnnotations,
      documents,
      skillTurnContext: dailyJournalSkillTurnContext({
        selectedSkillIds
      }),
      firstAssistantTextSeen: false,
      providerReasoningBlocks: new Map(),
      providerReasoningExposedMessageKeys: new Set(),
      reasoningSummary: createReasoningSummary({
        conversationId: catalog.conversationId,
        piSessionId: catalog.piSessionId,
        productRunId,
        startedAt: request.submittedAt
      }),
      knowledgeProgressDepth: new Map(),
      knowledgeToolStages: new Map(),
      knowledgeObservation: null,
      knowledgeWorkflow: null
    };
    active.currentRun = execution;
    active.pendingSettlement = execution;
    active.currentExecution = executionContext(
      productRunId,
      request.conversationId
    );
    if (request.signal) {
      const onAbort = () => {
        if (active.currentRun !== execution) return;
        // abort() sets the bound Knowledge signal before its first await.
        void this.abort(request.conversationId).catch(error => console.error("Pi lifecycle cancellation failed", error));
      };
      request.signal.addEventListener("abort", onAbort, { once: true });
      execution.releaseSubmissionAbort = () => request.signal!.removeEventListener("abort", onAbort);
      if (request.signal.aborted) onAbort();
    }

    try {
      assertPiSubmissionActive(execution.knowledgeAbort.signal);
      if (requestedThinkingLevel !== undefined) {
        active.session.setThinkingLevel(requestedThinkingLevel);
      }
      await this.emitRuntimeEvent(active, execution, {
        type: "reasoning_summary",
        summary: cloneReasoningSummary(execution.reasoningSummary)
      });
      this.configureToolsForTurn(active, knowledgeCommand, mode, memoryMode);
      if (execution.generation) {
        if (!this.options.generation || mode === "plan" || permission === "read-only" || englishDiarySourcePath || pdfTaskRequest || noteMentions.length || documents.length || promptImages.length || request.skillPath) throw new Error("生成需要独立的资料选择、Agent 模式和可写权限。");
        active.knowledgeTurnContext = null;
        // Do not send an unrelated branch to a summarization Provider before
        // before_agent_start/context has isolated this generation request.
        if (typeof active.session.setAutoCompactionEnabled === "function") {
          execution.generation.previousAutoCompaction = active.session.autoCompactionEnabled;
          active.session.setAutoCompactionEnabled(false);
        }
        this.appendGenerationEntry(active, GENERATION_REQUEST_ENTRY, { productRunId, request: execution.generation.request });
        await this.setGenerationStage(active, execution, "reading");
        execution.generation.assessment = await this.options.generation.prepare(execution.generation.request, this.generationIdentity(active, execution));
        const inputBudget = active.generationInputBudget ?? calculatePiEffectiveInputBudget({ contextWindow: active.session.model!.contextWindow, maxOutputReserve: active.session.model!.maxTokens }).effectiveInputBudget;
        assertGenerationInputBudget(execution.generation.request, execution.generation.assessment.sources, inputBudget, request.text);
        await this.setGenerationStage(active, execution, "writing");
      } else if (englishDiarySourcePath) {
        active.knowledgeTurnContext = null;
      } else if (knowledgeCommand.kind === "ask") {
        await this.emitRuntimeEvent(active, execution, {
          type: "knowledge_progress",
          status: "active",
          stage: "searching"
        });
        const preflight = await this.options.knowledge!.retrieveAsk({
          signal: execution.knowledgeAbort.signal,
          vaultId: catalog.vaultId,
          conversationId: catalog.conversationId,
          piSessionId: catalog.piSessionId,
          productRunId,
          question: knowledgeCommand.question,
          explicitPaths: knowledgeCommand.explicitPaths,
          includeUnrefined: knowledgeCommand.includeUnrefined
        });
        execution.knowledgeWorkflow = {
          kind: "ask",
          references: preflight.references,
          personalMemorySources: Object.freeze([]),
          bufferedAssistantEvents: []
        };
        execution.knowledgeObservation = createKnowledgeObservation(
          "ask",
          preflight.retrieval
        );
        await this.emitRuntimeEvent(active, execution, {
          type: "knowledge_progress",
          status: "completed",
          stage: "searching"
        });
        active.knowledgeTurnContext = Object.freeze({
          kind: "ask",
          providerResourceText: preflight.providerResourceText,
          references: preflight.references
        });
      } else if (mode !== "plan"
        && knowledgeCommand.kind === "chat"
        && this.options.knowledge?.retrieveChat
        && shouldPreflightPersonalKnowledge(request.text, execution.skillTurnContext?.skillId)) {
        await this.emitRuntimeEvent(active, execution, {
          type: "knowledge_progress",
          status: "active",
          stage: "searching"
        });
        const preflight = await this.options.knowledge.retrieveChat({
          signal: execution.knowledgeAbort.signal,
          vaultId: catalog.vaultId,
          conversationId: catalog.conversationId,
          piSessionId: catalog.piSessionId,
          productRunId,
          question: request.text,
          explicitPaths: [],
          includeUnrefined: false
        });
        execution.knowledgeWorkflow = {
          kind: "chat",
          references: preflight.references,
          bufferedAssistantEvents: []
        };
        execution.knowledgeObservation = createKnowledgeObservation(
          "chat",
          preflight.retrieval
        );
        await this.emitRuntimeEvent(active, execution, {
          type: "knowledge_progress",
          status: "completed",
          stage: "searching"
        });
        active.knowledgeTurnContext = Object.freeze({
          kind: "chat",
          providerResourceText: preflight.providerResourceText,
          references: preflight.references
        });
        if (
          !execution.requiresFreshnessVerification
          && knowledgeReferencesRequireFreshnessVerification(
            request.text,
            preflight.references,
            this.now()
          )
        ) {
          execution.requiresFreshnessVerification = true;
          this.configureToolsForTurn(active, knowledgeCommand, mode, memoryMode);
        }
      } else if (knowledgeCommand.kind === "maintain" && (permission === "read-only" || mode === "plan" || maintenanceRequestsAdviceOnly(knowledgeCommand.request))) {
        execution.knowledgeObservation = createKnowledgeObservation("maintain", null);
        active.knowledgeTurnContext = Object.freeze({
          kind: "chat",
          providerResourceText: "当前请求维护知识库。工作区只读：按需读取已有资料、分析并提出维护建议，不执行内容写入。",
          references: Object.freeze([])
        });
      } else if (knowledgeCommand.kind === "maintain") {
        await this.options.assertAgentActionAllowed?.({ catalog, action: "knowledge-write", access: { permission, mode, memoryMode } });
        const preference =
          await this.options.knowledge!.prepareMaintenancePreferences?.();
        if (!preference) {
          throw new PiNativeConversationRuntimeError(
            "agent_session_invalid",
            "Pi Knowledge maintenance preferences are unavailable"
          );
        }
        const suppliedScope = request.maintenanceScope;
        if (suppliedScope?.mode === "global" && knowledgeCommand.request.trim()) normalizePiKnowledgeMaintenanceScope(suppliedScope, knowledgeCommand.request);
        const frozenScope = !suppliedScope || (suppliedScope.mode === "global" && !suppliedScope.sourcePaths)
          ? await this.options.knowledge?.resolveMaintenanceScope?.(knowledgeCommand.request) ?? suppliedScope
          : suppliedScope;
        const resolvedCommand = maintenanceCommandContext(knowledgeCommand, preference, frozenScope);
        const structureResult = await this.options.knowledge?.prepareMaintenanceStructure?.({
          initialization: request.maintenanceScope?.mode === "batch",
          assertActive: () => { if (execution.abortRequested) throw new DOMException("维护已取消", "AbortError"); }
        });
        const scope = resolvedCommand.scope.mode === "global" ? resolvedCommand.scope : resolvedCommand.scope.mode === "query"
          ? { ...resolvedCommand.scope, candidatePaths: resolvedCommand.scope.candidatePaths.map((value) => resolveKnowledgePath(active.cwd, value, false)) }
          : resolvedCommand.scope.mode === "exact" ? { ...resolvedCommand.scope, sourcePaths: [resolveKnowledgePath(active.cwd, resolvedCommand.scope.sourcePaths[0], false)] as const }
          : { ...resolvedCommand.scope, sourcePaths: resolvedCommand.scope.sourcePaths.map((value) => resolveKnowledgePath(active.cwd, value, false)) };
        const scopedPaths = scope.mode === "query" ? scope.candidatePaths : scope.sourcePaths ?? [];
        if (scopedPaths.some(relative => knowledgePathRole(active.cwd, relative) !== "raw")) throw new PiNativeConversationRuntimeError("agent_session_invalid", "维护范围包含未绑定的资料来源，请重新选择。");
        execution.maintenanceScope = scope;
        const command = Object.freeze({ ...resolvedCommand, scope, folderBindingsRevision: scope.mode === "global" ? scope.folderBindingsRevision ?? getKnowledgeFolderBindings(active.cwd)?.revision : getKnowledgeFolderBindings(active.cwd)?.revision, preference: Object.freeze({
          ...preference, providerResourceText: [structureResult, preference.providerResourceText].filter(Boolean).join("\n")
        }) });
        execution.knowledgeWorkflow = { kind: "maintain", command };
        execution.knowledgeObservation = createKnowledgeObservation(
          "maintain",
          null,
          command
        );
        await this.setKnowledgeProgressState(
          active,
          execution,
          "refining_knowledge",
          "active"
        );
        active.knowledgeTurnContext = Object.freeze({
          kind: "maintain",
          command
        });
      }
      assertPiSubmissionActive(execution.knowledgeAbort.signal);
    } catch (error) {
      this.abandonUnstartedProductRun(active, execution);
      throw error;
    }

    const promptText = execution.generation ? request.text : englishDiarySourcePath ? request.text : active.skillPromptPrefix
      ? `${active.skillPromptPrefix}\n\n${request.text}`
      : knowledgeCommand.kind === "chat" && active.skillCommandName
        ? `/skill:${active.skillCommandName} ${request.text}`
        : request.text;
    try {
      execution.reasoningStartEntryId = appendReasoningSummaryEntry(
        active.sessionManager,
        execution.reasoningSummary
      );
      assertPiSessionAppendsDurable({
        sessionRoot: this.catalog.sessionRootPath,
        sessionManager: active.sessionManager,
        expectedEntryIds: [execution.reasoningStartEntryId]
      });
      persistPiActiveLeaf({
        sessionRoot: this.catalog.sessionRootPath,
        sessionManager: active.sessionManager
      });
    } catch (reasoningStartError) {
      const closeErrors: unknown[] = [];
      if (execution.reasoningStartEntryId) {
        try {
          await this.closeAndPersistReasoningSummary(
            active,
            execution,
            "failed",
            this.now()
          );
        } catch (error) {
          closeErrors.push(error);
        }
      }
      this.abandonUnstartedProductRun(active, execution);
      throw productRunStartFailure(
        reasoningStartError,
        closeErrors,
        "Reasoning start snapshot durability failed"
      );
    }
    const promptStart = { readyAt: undefined as number | undefined, settled: false, error: undefined as unknown };
    let promptPromise: Promise<void>;
    try {
      promptPromise = active.session.prompt(promptText, {
        source: "interactive",
        // Pi appends the user Entry only after auth, compaction and
        // before_agent_start. Their duration is not an Entry-write timeout.
        preflightResult: (accepted) => {
          // Pi calls this after auth/compaction/before_agent_start and immediately
          // before starting its Agent, closing the early-abort startup race.
          assertPiSubmissionActive(execution.knowledgeAbort.signal);
          if (accepted) promptStart.readyAt = Date.now();
        },
        ...(promptImages.length ? { images: promptImages } : {})
      });
    } catch (promptStartError) {
      const cleanupErrors = await this.cleanupFailedProductRunStart(
        active,
        execution,
        Promise.resolve()
      );
      throw productRunStartFailure(
        promptStartError,
        cleanupErrors,
        "Pi prompt start failed and runtime cleanup was incomplete"
      );
    }
    void promptPromise.then(
      () => { promptStart.settled = true; },
      (error) => { promptStart.error = error; promptStart.settled = true; }
    );
    let userEntry: SessionEntry;
    try {
      userEntry = await waitForNewUserEntry(
        active.sessionManager,
        execution.baselineEntryIds,
        USER_ENTRY_WAIT_TIMEOUT_MS,
        promptStart
      );
      assertPiSessionAppendsDurable({
        sessionRoot: this.catalog.sessionRootPath,
        sessionManager: active.sessionManager,
        expectedEntryIds: [userEntry.id]
      });
      this.checkpointConversationLeaf(active);
    } catch (error) {
      await this.appendProductRunStartFailureDiagnostic(
        active,
        execution,
        "user_entry_readback",
        error
      );
      const cleanupErrors = await this.cleanupFailedProductRunStart(
        active,
        execution,
        promptPromise
      );
      throw productRunStartFailure(
        error,
        cleanupErrors,
        "Pi first Entry durability failed and runtime cleanup was incomplete"
      );
    }

    try {
      if (selectedDraft) {
        await this.catalog.removeDraft(selectedDraft.draftId);
      }
    } catch (error) {
      await this.appendProductRunStartFailureDiagnostic(
        active,
        execution,
        "draft_remove",
        error
      );
      const cleanupErrors = await this.cleanupFailedProductRunStart(
        active,
        execution,
        promptPromise
      );
      throw productRunStartFailureAfterUserEntry(
        error,
        cleanupErrors,
        "Pi user Entry 已接受，但草稿消费失败。",
        userEntry.id
      );
    }

    const createdAt = Math.max(request.submittedAt, this.now());
    let accepted: Readonly<PiProductRunRecord>;
    try {
      accepted = await this.productRuns.create({
        ...(this.options.resolveAgentRunSnapshot ? { agentSnapshot: this.options.resolveAgentRunSnapshot(catalog) } : {}),
        productRunId,
        conversationId: catalog.conversationId,
        piSessionId: catalog.piSessionId,
        userEntryId: userEntry.id,
        toolCallIds: [],
        memoryMode,
        permission,
        ...(execution.memoryRecall ? { memoryRecall: execution.memoryRecall } : {}),
        ...(execution.knowledgeObservation
          ? { knowledge: freezeKnowledgeObservation(execution.knowledgeObservation) }
          : {}),
        state: "accepted",
        activeLeafId: active.sessionManager.getLeafId(),
        createdAt,
        updatedAt: createdAt
      });
    } catch (storageError) {
      await this.appendProductRunStartFailureDiagnostic(
        active,
        execution,
        "product_run_create",
        storageError
      );
      const cleanupErrors = await this.cleanupFailedProductRunStart(
        active,
        execution,
        promptPromise
      );
      throw productRunStartFailureAfterUserEntry(
        storageError,
        cleanupErrors,
        cleanupErrors.length > 0
          ? "Pi user Entry 已接受，但 ProductRun 创建与清理未完整完成。"
          : "Pi user Entry 已接受，但 ProductRun 创建失败。",
        userEntry.id
      );
    }
    try {
      await this.productRuns.update(productRunId, {
        state: "running",
        activeLeafId: active.sessionManager.getLeafId(),
        updatedAt: Math.max(createdAt, this.now())
      });
    } catch (storageError) {
      await this.appendProductRunStartFailureDiagnostic(
        active,
        execution,
        "product_run_mark_running",
        storageError
      );
      const cleanupErrors = await this.cleanupFailedProductRunStart(
        active,
        execution,
        promptPromise
      );
      throw productRunStartFailureAfterUserEntry(
        storageError,
        cleanupErrors,
        cleanupErrors.length > 0
          ? "Pi user Entry 已接受，但 ProductRun 标记运行与清理未完整完成。"
          : "Pi user Entry 已接受，但 ProductRun 标记运行失败。",
        userEntry.id
      );
    }
    if (execution.generation) {
      // Local preflight/auth may fail before a formal run exists. Keep its
      // phases transient until the user Entry and ProductRun are both durable.
      execution.generation.durable = true;
      for (const entry of execution.generation.pendingEntries) this.appendGenerationEntry(active, entry.customType, entry.data);
      execution.generation.pendingEntries = [];
    }
    const result = this.completeProductRun(
      active,
      execution,
      accepted,
      promptPromise
    );
    return Object.freeze({
      productRunId,
      conversationId: catalog.conversationId,
      piSessionId: catalog.piSessionId,
      userEntryId: userEntry.id,
      result
    });
  }

  private appendGenerationEntry(active: ActiveConversation, customType: string, data: unknown): void {
    const generation = active.currentRun?.generation;
    if (generation && !generation.durable) {
      generation.pendingEntries.push({ customType, data: structuredClone(data) });
      return;
    }
    const id = active.sessionManager.appendCustomEntry(customType, data);
    assertPiSessionAppendsDurable({ sessionRoot: this.catalog.sessionRootPath, sessionManager: active.sessionManager, expectedEntryIds: [id] });
    this.checkpointConversationLeaf(active);
  }
  private generationIdentity(active: ActiveConversation, execution: ActiveProductRun): GenerationExecutionIdentity {
    return { conversationId: active.catalog.conversationId, piSessionId: active.catalog.piSessionId, productRunId: execution.productRunId,
      vaultId: active.catalog.vaultId, access: { permission: execution.permission, mode: execution.mode, memoryMode: "no_memory" }, signal: execution.knowledgeAbort.signal };
  }
  private async setGenerationStage(active: ActiveConversation, execution: ActiveProductRun, stage?: GenerationStage, finalStatus: "completed" | "failed" | "cancelled" = "completed"): Promise<void> {
    const generation = execution.generation; if (!generation) return;
    if (generation.stage) {
      const data = { productRunId: execution.productRunId, requestId: generation.request.id, stage: generation.stage, status: finalStatus, at: this.now() };
      this.appendGenerationEntry(active, GENERATION_STAGE_ENTRY, data);
      await this.emitRuntimeEvent(active, execution, { type: "generation_progress", requestId: generation.request.id, stage: generation.stage, status: finalStatus });
    }
    generation.stage = stage;
    if (stage) {
      const data = { productRunId: execution.productRunId, requestId: generation.request.id, stage, status: "running", at: this.now() };
      this.appendGenerationEntry(active, GENERATION_STAGE_ENTRY, data);
      await this.emitRuntimeEvent(active, execution, { type: "generation_progress", requestId: generation.request.id, stage, status: "running" });
    }
  }
  private configureToolsForTurn(
    active: ActiveConversation,
    command: Readonly<KnowledgeConversationCommand>,
    mode: PiChatMode,
    memoryMode: PiConversationMemoryMode
  ): void {
    if (active.currentRun?.generation) { active.session.setActiveToolsByName([]); return; }
    const names = resolvePiTurnToolNames({
      commandKind: command.kind,
      englishDiary: Boolean(active.currentRun?.englishDiarySourcePath),
      permission: active.currentRun?.permission ?? "read-only",
      mode,
      memoryMode,
      defaultToolNames: active.defaultToolNames,
      memoryToolNames: active.memoryToolNames,
      planToolNames: active.planToolNames,
      externalReadToolNames: active.externalReadToolNames,
      requiresFreshnessVerification:
        active.currentRun?.requiresFreshnessVerification === true
    }).filter(name => active.isToolCurrentlyEnabled?.(name) !== false);
    if (active.currentRun?.englishDiarySourcePath && names.length !== 1) throw new PiNativeConversationRuntimeError("agent_session_invalid", "英文日记能力、功能开关或 PRO 当前不可用。");
    if (mode === "plan") {
      if (
        names.length === 0
        || names.some(
          (name) => !active.registeredToolNames.has(name)
        )
      ) {
        throw new PiNativeConversationRuntimeError(
          "agent_session_invalid",
          "Pi Task/Plan read-only Tool registry is incomplete"
        );
      }
      active.session.setActiveToolsByName([...names]);
      return;
    }
    active.session.setActiveToolsByName([...names]);
  }

  private abandonUnstartedProductRun(
    active: ActiveConversation,
    execution: ActiveProductRun
  ): void {
    this.runChannels.delete(execution.productRunId);
    if (execution.generation && !execution.generation.durable) {
      active.projection.messages = active.projection.messages.filter(message => message.runId !== execution.productRunId);
      active.projection.runState = "idle";
      active.projection.productRunId = undefined;
    }
    this.finishProductRunRuntimeState(active, execution);
  }

  private finishProductRunRuntimeState(
    active: ActiveConversation,
    execution: ActiveProductRun
  ): void {
    if (execution.generation?.previousAutoCompaction !== undefined) active.session.setAutoCompactionEnabled(execution.generation.previousAutoCompaction);
    execution.releaseSubmissionAbort?.();
    execution.releaseSubmissionAbort = undefined;
    if (active.currentRun === execution) active.currentRun = null;
    if (active.currentExecution?.runId === execution.productRunId) {
      active.currentExecution = null;
    }
    active.knowledgeTurnContext = null;
    active.session.setActiveToolsByName(active.defaultToolNames.filter(name => active.isToolCurrentlyEnabled?.(name) !== false));
    execution.settlementBarrier.resolve();
    if (active.pendingSettlement === execution) {
      active.pendingSettlement = null;
    }
  }

  subscribeProductRun(
    productRunId: string,
    listener: PiChatRuntimeEventListener
  ): PiChatEventSubscription {
    const channel = this.runChannels.get(productRunId);
    if (!channel) {
      throw new PiNativeConversationRuntimeError(
        "conversation_not_found",
        `ProductRun ${productRunId} 不存在或已释放`
      );
    }
    return channel.subscribe(listener);
  }

  releaseProductRun(productRunId: string): boolean {
    for (const active of this.active.values()) {
      if (
        active.currentRun?.productRunId === productRunId
        || active.pendingSettlement?.productRunId === productRunId
      ) {
        return false;
      }
    }
    return this.runChannels.delete(productRunId);
  }

  private async cleanupFailedProductRunStart(
    active: ActiveConversation,
    execution: ActiveProductRun,
    promptPromise: Promise<void>
  ): Promise<unknown[]> {
    const cleanupErrors: unknown[] = [];
    try {
      await this.pauseTaskPlanForAbort(active, execution);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      active.session.clearQueue();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await active.session.abort();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await active.session.waitForIdle();
    } catch (error) {
      cleanupErrors.push(error);
    }
    await promptPromise.catch(() => undefined);
    try {
      await active.eventLane;
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await this.closeRemainingProviderReasoning(
        active,
        execution,
        execution.abortRequested ? "cancelled" : "failed",
        this.now()
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await this.closeAndPersistReasoningSummary(
        active,
        execution,
        execution.abortRequested ? "cancelled" : "failed",
        this.now()
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
    this.runChannels.delete(execution.productRunId);
    this.finishProductRunRuntimeState(active, execution);
    return cleanupErrors;
  }

  async transitionTaskPlan(
    request: Readonly<PiTaskPlanTransitionRequest>
  ): Promise<Readonly<PiTaskPlanTransitionResult>> {
    const active = await this.requireActiveConversation(
      request.conversationId
    );
    if (
      (active.currentRun || active.session.isStreaming)
      && request.action !== "pause"
    ) {
      throw new PiNativeConversationRuntimeError(
        "conversation_busy",
        "当前计划运行中，只能先暂停"
      );
    }
    const plan = latestTaskPlanFromBranch(
      active.sessionManager.getBranch(),
      request.planId
    );
    if (!plan) {
      throw new PiNativeConversationRuntimeError(
        "conversation_not_found",
        `当前 Branch 没有任务计划 ${request.planId}`
      );
    }
    const updated = transitionTaskPlanByUser({
      plan,
      action: request.action,
      updatedAt: Math.max(plan.updatedAt, this.now()),
      ...(active.currentRun
        ? { productRunId: active.currentRun.productRunId }
        : {})
    });
    appendTaskPlanEntry(active.sessionManager, active.catalog, updated);
    persistPiActiveLeaf({
      sessionRoot: this.catalog.sessionRootPath,
      sessionManager: active.sessionManager
    });
    active.projection = await this.rebuildProjection(
      active,
      active.projection.runState
    );
    if (active.currentRun) {
      const occurredAt = this.now();
      this.updateReasoningTaskPlan(active.currentRun, updated, occurredAt);
      await this.emitRuntimeEvent(active, active.currentRun, {
        type: "reasoning_summary",
        summary: cloneReasoningSummary(active.currentRun.reasoningSummary)
      });
    }
    if (request.action === "pause" && active.currentRun) {
      await this.abort(request.conversationId);
    }
    return Object.freeze({
      plan: updated,
      activeLeafId: active.sessionManager.getLeafId()
    });
  }

  async steer(conversationId: string, text: string): Promise<void> {
    const active = this.requireRunningConversation(conversationId);
    const plan = activeTaskPlanFromBranch(
      active.sessionManager.getBranch()
    );
    if (plan?.status === "in_progress" && active.currentRun) {
      const steered = taskPlanSteeringSnapshot({
        plan,
        directive: text,
        updatedAt: Math.max(plan.updatedAt, this.now()),
        productRunId: active.currentRun.productRunId
      });
      appendTaskPlanEntry(active.sessionManager, active.catalog, steered);
      persistPiActiveLeaf({
        sessionRoot: this.catalog.sessionRootPath,
        sessionManager: active.sessionManager
      });
      active.projection = await this.rebuildProjection(
        active,
        active.projection.runState
      );
      const occurredAt = this.now();
      this.updateReasoningTaskPlan(active.currentRun, steered, occurredAt);
      await this.emitRuntimeEvent(active, active.currentRun, {
        type: "reasoning_summary",
        summary: cloneReasoningSummary(active.currentRun.reasoningSummary)
      });
    }
    await active.session.steer(text);
  }

  async followUp(conversationId: string, text: string): Promise<void> {
    const active = this.requireRunningConversation(conversationId);
    await active.session.followUp(text);
  }

  private async requireDraftForSubmission(
    catalog: Readonly<PiConversationCatalogEntry>,
    draftId: string
  ): Promise<Readonly<PiConversationDraftRecord>> {
    const normalizedDraftId = requireNonEmptyRuntimeString(
      draftId,
      "draftId"
    );
    const draft = (await this.catalog.drafts(catalog.conversationId)).find(
      (candidate) => candidate.draftId === normalizedDraftId
    );
    if (!draft) {
      throw new PiNativeConversationRuntimeError(
        "draft_invalid",
        `Conversation ${catalog.conversationId} 的草稿 ${normalizedDraftId} 不存在或已处理`
      );
    }
    assertDraftIdentity(draft, catalog);
    return draft;
  }

  /** A verified cursor checkpoint is needed before a later open can restore this Branch. */
  private checkpointConversationLeaf(active: ActiveConversation): void {
    const leaf = active.sessionManager.getLeafId();
    if (leaf === active.lastPersistedLeafId) return;
    persistPiActiveLeaf({ sessionRoot: this.catalog.sessionRootPath, sessionManager: active.sessionManager });
    active.lastPersistedLeafId = leaf;
  }

  /** Repair only a provably stale pre-acceptance cursor during explicit task resume. */
  private async prepareTaskResumeBranch(catalog: Readonly<PiConversationCatalogEntry>, resume: TaskResumeContext, signal?: AbortSignal): Promise<void> {
    const prior = await this.productRuns.read(resume.safety.interruptedRunId);
    assertPiSubmissionActive(signal);
    const fail = (): never => { throw new PiNativeConversationRuntimeError("agent_session_invalid", "无法确认原任务的当前记录分支，本次没有继续。请保留记录并重新核对，避免丢失原任务上下文。"); };
    if (!prior || prior.conversationId !== catalog.conversationId || prior.piSessionId !== catalog.piSessionId || prior.userEntryId !== resume.safety.interruptedUserEntryId) return fail();
    const existing = this.active.get(catalog.conversationId);
    if (existing?.currentRun || existing?.session.isStreaming) throw new PiNativeConversationRuntimeError("conversation_busy", "当前任务仍在运行，请等待本轮完成。");
    if (existing?.sessionManager.getBranch().some(entry => entry.id === prior.userEntryId)) return;
    const opened = await this.openCatalogSession(catalog);
    assertPiSubmissionActive(signal);
    const manager = opened.sessionManager;
    if (manager.getBranch().some(entry => entry.id === prior.userEntryId)) return;
    const checkpoint = readPiActiveLeafCheckpoint({ sessionRoot: this.catalog.sessionRootPath, piSessionId: catalog.piSessionId });
    // A later selection can be intentional. Never replace it by choosing the last JSONL line.
    if (!checkpoint || checkpoint.modifiedAt > prior.createdAt || prior.state === "product_run_settled" || !prior.activeLeafId) return fail();
    const anchorBranch = manager.getBranch(prior.activeLeafId);
    if (!anchorBranch.some(entry => entry.id === prior.userEntryId)
      || checkpoint.activeLeafId !== null && !anchorBranch.some(entry => entry.id === checkpoint.activeLeafId)) fail();
    const descendants = new Set([prior.activeLeafId]);
    const parents = new Set<string>();
    for (const entry of manager.getEntries()) {
      if (entry.parentId === null || !descendants.has(entry.parentId)) continue;
      if (entry.type === "message" && entry.message.role === "user" && entry.id !== prior.userEntryId) continue;
      descendants.add(entry.id); parents.add(entry.parentId);
    }
    const leaves = [...descendants].filter(id => !parents.has(id));
    if (leaves.length !== 1) fail();
    if (existing) await this.releaseConversation(catalog.conversationId);
    assertPiSubmissionActive(signal);
    manager.branch(leaves[0]);
    persistPiActiveLeaf({ sessionRoot: this.catalog.sessionRootPath, sessionManager: manager });
  }

  /** Record an evidenced stop cause before cancellation; no change to task Catalog. */
  async recordTaskInterruption(conversationId: string, reason: TaskInterruptionReason): Promise<void> {
    const active = this.active.get(conversationId);
    const execution = active?.currentRun ?? active?.pendingSettlement;
    if (!active || !execution) return;
    const interruption: TaskInterruptionRecord = {
      at: this.now(), reason, stage: taskInterruptionStage(active)
    };
    // Bind synchronously so cancellation settlement cannot race away the cause.
    execution.interruption = interruption;
    this.checkpointConversationLeaf(active);
    const run = await this.productRuns.read(execution.productRunId);
    if (run && run.state !== "product_run_settled") await this.productRuns.update(run.productRunId, { interruption, activeLeafId: active.sessionManager.getLeafId(), toolCallIds: [...execution.toolCallIds], updatedAt: Math.max(run.updatedAt, interruption.at) });
  }

  async abort(conversationId: string): Promise<void> {
    const active = this.active.get(conversationId);
    if (!active?.currentRun) return;
    const execution = active.currentRun;
    execution.abortRequested = true;
    this.finishProviderWait(execution, "cancelled");
    execution.knowledgeAbort.abort();
    const abortErrors: unknown[] = [];
    try {
      await this.pauseTaskPlanForAbort(active, execution);
    } catch (error) {
      abortErrors.push(error);
    }
    if (active.currentRun !== execution) return;
    let cleared: { steering: string[]; followUp: string[] } | null = null;
    try {
      cleared = active.session.clearQueue();
    } catch (error) {
      abortErrors.push(error);
    }
    try {
      await active.queuePersistenceLane;
    } catch (error) {
      abortErrors.push(error);
    }
    if (active.currentRun !== execution) return;
    if (cleared) {
      try {
        await this.persistAbortDrafts(active, execution, cleared);
      } catch (error) {
        abortErrors.push(error);
      }
    }
    if (active.currentRun !== execution) return;
    try {
      active.session.abortCompaction();
    } catch (error) {
      abortErrors.push(error);
    }
    try {
      await active.session.abort();
    } catch (error) {
      abortErrors.push(error);
    }
    try {
      await active.session.waitForIdle();
    } catch (error) {
      abortErrors.push(error);
    }
    if (abortErrors.length > 0) {
      throw combinedOperationError(
        abortErrors,
        `Conversation ${conversationId} abort failed`
      );
    }
  }

  private async pauseTaskPlanForAbort(
    active: ActiveConversation,
    execution: ActiveProductRun
  ): Promise<void> {
    const plan = activeTaskPlanFromBranch(
      active.sessionManager.getBranch()
    );
    if (plan?.status !== "in_progress") return;
    const paused = pauseTaskPlanForRuntime({
      plan,
      updatedAt: Math.max(plan.updatedAt, this.now()),
      productRunId: execution.productRunId,
      summary: "运行已中止，计划暂停"
    });
    appendTaskPlanEntry(active.sessionManager, active.catalog, paused);
    persistPiActiveLeaf({
      sessionRoot: this.catalog.sessionRootPath,
      sessionManager: active.sessionManager
    });
    active.projection = await this.rebuildProjection(
      active,
      active.projection.runState
    );
  }

  private settleTaskPlanAfterRun(
    active: ActiveConversation,
    execution: ActiveProductRun,
    terminalState: PiProductRunTerminalState
  ): void {
    if (execution.abortRequested) return;
    const plan = activeTaskPlanFromBranch(
      active.sessionManager.getBranch()
    );
    if (!plan) return;
    if (terminalState === "failed") {
      if (
        plan.status !== "in_progress"
        && plan.productRunId !== execution.productRunId
      ) return;
      appendTaskPlanEntry(
        active.sessionManager,
        active.catalog,
        failTaskPlanForProductRun({
          plan,
          updatedAt: Math.max(plan.updatedAt, this.now()),
          productRunId: execution.productRunId,
          reason: "任务执行失败"
        })
      );
      return;
    }
    if (execution.mode !== "agent" || plan.status !== "in_progress") return;
    appendTaskPlanEntry(
      active.sessionManager,
      active.catalog,
      pauseTaskPlanForRuntime({
        plan,
        updatedAt: Math.max(plan.updatedAt, this.now()),
        productRunId: execution.productRunId,
        summary: terminalState === "cancelled"
          ? "本轮执行已中断，计划暂停等待继续"
          : "本轮执行已结束，计划暂停等待继续"
      })
    );
  }

  async navigateBranch(
    conversationId: string,
    targetEntryId: string,
    options: {
      summarize?: boolean;
      customInstructions?: string;
      replaceInstructions?: boolean;
      label?: string;
    } = {}
  ): Promise<PiBranchNavigationResult> {
    const active = await this.requireActiveConversation(conversationId);
    if (active.currentRun || active.session.isStreaming) {
      throw new PiNativeConversationRuntimeError(
        "conversation_busy",
        "运行期间不能切换 Branch"
      );
    }
    const previousLeafId = active.sessionManager.getLeafId();
    active.currentExecution = executionContext(
      this.nextId("branch"),
      conversationId
    );
    try {
      const result = await active.session.navigateTree(
        targetEntryId,
        options
      );
      if (!result.cancelled) {
        persistPiActiveLeaf({
          sessionRoot: this.catalog.sessionRootPath,
          sessionManager: active.sessionManager
        });
        active.projection = await this.rebuildProjection(
          active,
          active.projection.runState
        );
      }
      return Object.freeze({
        activeLeafId: active.sessionManager.getLeafId(),
        editorText: result.editorText,
        cancelled: result.cancelled
      });
    } finally {
      active.currentExecution = null;
      if (active.sessionManager.getLeafId() !== previousLeafId) {
        active.projection = await this.rebuildProjection(
          active,
          active.projection.runState
        );
      }
    }
  }

  async compactConversation(
    conversationId: string,
    customInstructions?: string
  ): Promise<void> {
    const active = await this.requireActiveConversation(conversationId);
    if (active.currentRun || active.session.isStreaming) {
      throw new PiNativeConversationRuntimeError(
        "conversation_busy",
        "运行期间不能启动独立 Compaction"
      );
    }
    active.currentExecution = executionContext(
      this.nextId("compaction"),
      conversationId
    );
    try {
      await active.session.compact(customInstructions);
      persistPiActiveLeaf({
        sessionRoot: this.catalog.sessionRootPath,
        sessionManager: active.sessionManager
      });
      active.projection = await this.rebuildProjection(
        active,
        active.projection.runState
      );
    } finally {
      active.currentExecution = null;
    }
  }

  async readProjection(
    conversationId: string
  ): Promise<PiConversationProjection> {
    this.assertReady();
    const active = this.active.get(conversationId);
    if (active) return await this.projectionFromActive(active);
    return await readDurablePiConversationProjection({
      catalog: this.catalog,
      productRuns: this.productRuns,
      sessionApi: this.options.sessionApi,
      conversationId,
      resolveConversationCwd: (targetConversationId) =>
        this.options.resolveConversationCwd(targetConversationId),
      ...(this.options.loadToolProductState
        ? {
            loadToolProductState: (request) =>
              this.options.loadToolProductState!(request)
          }
        : {}),
      ...(this.options.loadKnowledgeDecorations
        ? {
            loadKnowledgeDecorations: (request) =>
              this.options.loadKnowledgeDecorations!(request)
          }
        : {}),
      projector: this.projector,
      now: this.now
    });
  }

  async recordAnswerSave(conversationId: string, messageId: string, path: string): Promise<void> {
    this.assertReady();
    const pending = this.activating.get(conversationId);
    if (pending) {
      await pending.catch(() => undefined);
      return await this.recordAnswerSave(conversationId, messageId, path);
    }
    const active = this.active.get(conversationId);
    if (!active) {
      // Reuse the activation lane: neither operation may open a second manager
      // while the other is awaiting catalog/session preparation.
      const recording = recordDurablePiAnswerSave({
        catalog: this.catalog, sessionApi: this.options.sessionApi, conversationId, messageId, path,
        resolveConversationCwd: id => this.options.resolveConversationCwd(id), now: this.now
      });
      this.activating.set(conversationId, recording);
      try {
        await recording;
      } finally {
        if (this.activating.get(conversationId) === recording) this.activating.delete(conversationId);
      }
      return;
    }
    appendSavedAnswerNote({
      sessionRoot: this.catalog.sessionRootPath, sessionManager: active.sessionManager,
      piSessionId: active.catalog.piSessionId,
      assistantEntryId: piEntryIdFromProjectedMessageId(messageId) ?? "", path
    });
    active.lastPersistedLeafId = active.sessionManager.getLeafId();
    projectSavedAnswerNotes(active.projection.messages, active.sessionManager.getBranch(), active.catalog.piSessionId);
  }

  async releaseConversation(conversationId: string): Promise<void> {
    const active = this.active.get(conversationId);
    if (!active) return;
    const releaseErrors: unknown[] = [];
    const execution = active.currentRun ?? active.pendingSettlement;
    if (execution) {
      try {
        await this.abort(conversationId);
      } catch (error) {
        releaseErrors.push(error);
      }
      try {
        await active.session.waitForIdle();
      } catch (error) {
        releaseErrors.push(error);
      }
      try {
        await active.eventLane;
      } catch (error) {
        releaseErrors.push(error);
      }
      try {
        await active.queuePersistenceLane;
      } catch (error) {
        releaseErrors.push(error);
      }
      await execution.settlementBarrier.promise;
    }
    try {
      await active.session.settingsManager.flush();
    } catch (error) {
      releaseErrors.push(error);
    }
    try {
      active.unsubscribe();
    } catch (error) {
      releaseErrors.push(error);
    }
    try {
      active.session.dispose();
    } catch (error) {
      releaseErrors.push(error);
    }
    this.active.delete(conversationId);
    if (releaseErrors.length > 0) {
      throw combinedOperationError(
        releaseErrors,
        `Conversation ${conversationId} release failed`
      );
    }
  }

  async releaseConversationIfIdle(conversationId: string): Promise<boolean> {
    const active = this.active.get(conversationId);
    if (
      !active
      || this.submitting.has(conversationId)
      || this.activating.has(conversationId)
      || active.currentRun
      || active.pendingSettlement
      || active.session.isStreaming
    ) {
      return false;
    }
    await this.releaseConversation(conversationId);
    return true;
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    try {
      this.options.disposeRuntimeResources?.();
      for (const conversationId of [...this.active.keys()]) {
        await this.releaseConversation(conversationId);
      }
    } finally {
      this.runChannels.clear();
      this.initialized = false;
    }
  }

  private async requireActiveConversation(
    conversationId: string,
    options: ActivatePiNativeConversationOptions = {}
  ): Promise<ActiveConversation> {
    const pending = this.activating.get(conversationId);
    if (pending) {
      await pending.catch(() => undefined);
      return await this.requireActiveConversation(conversationId, options);
    }
    const activation = this.createActiveConversation(conversationId, options);
    this.activating.set(conversationId, activation);
    try {
      return await activation;
    } finally {
      if (this.activating.get(conversationId) === activation) {
        this.activating.delete(conversationId);
      }
    }
  }

  private async createActiveConversation(
    conversationId: string,
    options: ActivatePiNativeConversationOptions
  ): Promise<ActiveConversation> {
    this.assertReady();
    this.assertConversationNotRecovering(conversationId);
    assertValidSkillBinding(options);
    const resourceKey = resourceKeyFor(options);
    const existing = this.active.get(conversationId);
    const selectedModelMatches = !options.runtimeProviderId
      || (existing?.session.model?.provider === options.runtimeProviderId
        && existing.session.model.id === options.modelId
        && (!options.providerSettingsId
          || existing.providerSettingsId === options.providerSettingsId));
    if (existing && existing.resourceKey === resourceKey && selectedModelMatches) {
      return existing;
    }
    if (existing) {
      if (existing.currentRun || existing.session.isStreaming) {
        throw new PiNativeConversationRuntimeError(
          "conversation_busy",
          "运行期间不能替换模型或 Skill/Resource 绑定"
        );
      }
      await this.releaseConversation(conversationId);
    }

    const catalog = await this.requireCatalogConversation(conversationId);
    if (catalog.status === "deleted") {
      throw new PiNativeConversationRuntimeError(
        "conversation_deleted",
        `Conversation ${conversationId} 已删除`
      );
    }
    const opened = await this.openCatalogSession(catalog);
    const cwd = await this.options.resolveConversationCwd(conversationId);
    const holder: { active: ActiveConversation | null } = { active: null };
    const created = await this.options.createAgentSession({
      catalog,
      cwd,
      providerSettingsId: options.providerSettingsId,
      runtimeProviderId: options.runtimeProviderId,
      modelId: options.modelId,
      sessionManager: opened.sessionManager,
      skillPath: options.skillPath,
      skillName: options.skillName,
      skillPaths: options.skillPaths,
      skillNames: options.skillNames,
      currentExecutionContext: () => {
        const active = holder.active;
        const run = active?.currentRun;
        const execution = active?.currentExecution;
        if (!active || !execution) {
          throw new PiNativeConversationRuntimeError(
            "provider_execution_unbound",
            "Provider request has no bound Pi-native execution"
          );
        }
        assertPiSubmissionActive(run?.knowledgeAbort.signal);
        this.checkpointConversationLeaf(active);
        if (run && run.providerStartedAt === undefined) {
          const providerStartedAt = this.now();
          run.providerStartedAt = providerStartedAt;
          this.queueReasoningActivity(active, run, {
            id: "provider",
            kind: "provider",
            status: "active",
            stage: "requesting",
            startedAt: providerStartedAt,
            updatedAt: providerStartedAt
          });
          run.providerWaitTimer = setInterval(() => {
            if (active.currentRun !== run || run.firstAssistantTextSeen
              || run.knowledgeAbort.signal.aborted || run.reasoningSummary.terminalAt !== undefined) {
              this.finishProviderWait(run);
              return;
            }
            const observedAt = this.now();
            if (observedAt - providerStartedAt <= 5_000) return;
            this.queueReasoningActivity(active, run, {
              id: "provider", kind: "provider", status: "active", stage: "requesting",
              startedAt: providerStartedAt, updatedAt: observedAt
            });
          }, 1_000);
        }
        return execution;
      },
      currentToolExecutionContext: () => {
        const active = holder.active;
        const run = active?.currentRun;
        if (!active || !run) {
          throw new PiNativeConversationRuntimeError(
            "provider_execution_unbound",
            "Tool execution has no bound ProductRun"
          );
        }
        assertPiSubmissionActive(run.knowledgeAbort.signal);
        this.checkpointConversationLeaf(active);
        const userEntry = currentRunUserEntry(active.sessionManager, run.baselineEntryIds);
        return {
          conversationId: catalog.conversationId,
          piSessionId: catalog.piSessionId,
          productRunId: run.productRunId,
          vaultId: catalog.vaultId,
          userEntryId: userEntry.id,
          userEntryText: publicMessageText(userEntry.message)
        };
      },
      currentMaintenanceCommand: async () => {
        const run = holder.active?.currentRun;
        if (!run) throw new Error("knowledge_maintenance_command_unavailable");
        await this.options.assertAgentActionAllowed?.({ catalog: holder.active?.catalog ?? catalog, action: "knowledge-write", access: { permission: run.permission, mode: run.mode, memoryMode: run.memoryMode } });
        if (run.knowledgeWorkflow?.kind === "maintain") return run.knowledgeWorkflow.command;
        const preference = await this.options.knowledge?.prepareMaintenancePreferences?.();
        if (!preference) throw new Error("knowledge_maintenance_preferences_unavailable");
        const routed = routeKnowledgeConversationCommand(run.requestText);
        const request = routed.kind === "ask" ? routed.question : run.requestText;
        const scope = run.maintenanceScope ?? await this.options.knowledge?.resolveMaintenanceScope?.(request);
        return maintenanceCommandContext({
          kind: "maintain", originalText: run.requestText, request
        }, preference, scope);
      },
      currentWorkspaceAccess: () => {
        const run = holder.active?.currentRun;
        return run ? Object.freeze({ permission: run.permission, mode: run.mode, memoryMode: run.memoryMode }) : null;
      },
      currentTaskResumeContext: () => holder.active?.currentRun?.resumeContext,
      bindPdfDeliveryJob: jobId => { const run = holder.active?.currentRun; if (run) (run.pdfDeliveryJobs ??= new Set()).add(jobId); },
      currentPdfTaskRequest: () => holder.active?.currentRun?.pdfTaskRequest,
      currentEnglishDiaryRequest: () => {
        const active = holder.active, run = active?.currentRun;
        if (!active || !run?.englishDiarySourcePath) return null;
        const stored = englishDiaryTaskContextFromEntries(active.sessionManager.getBranch());
        // before_agent_start runs before Pi appends this turn's user entry.
        // Bind the source intent to the task; the tool separately binds the live user entry.
        return { sourcePath: run.englishDiarySourcePath, intentEntryId: stored?.intentEntryId ?? `english-diary:${catalog.conversationId}` };
      },
      currentGenerationContext: () => {
        const generation = holder.active?.currentRun?.generation;
        return generation?.assessment ? { request: generation.request, assessment: generation.assessment } : null;
      },
      currentWorkbenchSource: () => holder.active?.currentRun?.workbenchSource
        ?? workbenchTaskSourceFromEntries(holder.active?.sessionManager.getBranch() ?? []),
      currentKnowledgeTurnContext: () =>
        holder.active?.knowledgeTurnContext ?? null,
      currentSkillTurnContext: () =>
        holder.active?.currentRun?.skillTurnContext ?? null,
      currentMemoryTurnContext: () => {
        const active = holder.active;
        const run = active?.currentRun;
        if (!active || !run || run.englishDiarySourcePath || run.generation) return null;
        const branch = active.sessionManager.getBranch();
        // before_agent_start may run before or after Pi appends this turn's
        // user message. Entry identity preserves earlier identical text.
        const currentUserEntry = branch.find((entry) =>
          !run.baselineEntryIds.has(entry.id)
          && entry.type === "message"
          && entry.message.role === "user"
        );
        return Object.freeze({
          vaultId: catalog.vaultId,
          conversationId: catalog.conversationId,
          piSessionId: catalog.piSessionId,
          productRunId: run.productRunId,
          memoryMode: run.memoryMode,
          ...(run.projectId ? { projectId: run.projectId } : {}),
          query: run.requestText,
          recentConversation: selectMemoryRecallPreviousUserContext(branch.flatMap((entry) =>
            entry.id !== currentUserEntry?.id && entry.type === "message" && entry.message.role === "user"
              ? [{ role: entry.message.role, content: publicMessageText(entry.message) }]
              : []))
        });
      },
      currentSelectionAnnotationTurnContext: () => holder.active?.currentRun?.selectionAnnotations ?? [],
      currentNoteMentionTurnContext: () => {
        const noteMentions = holder.active?.currentRun?.noteMentions ?? [];
        return noteMentions.length
          ? Object.freeze({ noteMentions })
          : null;
      },
      bindPdfMaintenanceSources: (paths) => {
        const run = holder.active?.currentRun;
        if (!run || !paths.length || paths.length > 20) throw new Error("PDF maintenance scope unavailable");
        run.maintenanceScope = { mode: "batch", sourcePaths: [...new Set(paths)] };
      },
      consumePdfDocument: (attachmentId, sha256) => {
        const active = holder.active, run = active?.currentRun;
        if (!active || !run) return null;
        const document = run.documents.find(d => d.transport === "tool_reference" && d.attachmentId === attachmentId && d.sha256 === sha256);
        if (!document) return null;
        run.documents = run.documents.filter(d => d !== document);
        (document.bytes as Uint8Array).fill(0);
        return { conversationId: catalog.conversationId, userEntryId: currentRunUserEntry(active.sessionManager, run.baselineEntryIds).id };
      },
      currentDocumentTurnContext: () => {
        const documents = holder.active?.currentRun?.documents ?? [];
        return documents.length
          ? Object.freeze({ documents })
          : null;
      },
      currentTaskPlanTurnContext: () => {
        const active = holder.active;
        const run = active?.currentRun;
        if (!active || !run) return null;
        const branch = active.sessionManager.getBranch();
        return Object.freeze({
          mode: run.mode,
          plan: activeTaskPlanFromBranch(branch)
            ?? latestTaskPlanFromBranch(branch)
        });
      },
      currentSuccessfulExternalReadToolNames: () => {
        const active = holder.active;
        const run = active?.currentRun;
        if (!active || !run) return Object.freeze([]);
        return Object.freeze([...run.successfulCapabilityIds]
          .filter((name) => active.externalReadToolNames.includes(name))
          .sort());
      },
      reportAskPersonalMemorySources: async (input) => {
        const active = holder.active;
        const run = active?.currentRun;
        const ask = run?.knowledgeWorkflow;
        if (
          !active
          || !run
          || run.productRunId !== input.productRunId
          || ask?.kind !== "ask"
        ) return;
        ask.personalMemorySources = mergePersonalMemorySourceReferences(
          ask.personalMemorySources,
          input.sources
        );
      },
      reportPersonalMemorySourcesInjected: async input => {
        const active = holder.active;
        const run = active?.currentRun;
        if (!active || !run || run.memoryMode === "no_memory" || run.productRunId !== input.productRunId) return;
        const sources = normalizeInjectedMemorySources(input.sources);
        if (!sources.length || active.sessionManager.getBranch().some(entry => entry.type === "custom"
          && entry.customType === PI_MEMORY_SOURCES_ENTRY_TYPE && (entry.data as { productRunId?: string })?.productRunId === run.productRunId)) return;
        const id = active.sessionManager.appendCustomEntry(PI_MEMORY_SOURCES_ENTRY_TYPE, {
          schemaVersion: 1, conversationId: active.catalog.conversationId,
          piSessionId: active.catalog.piSessionId, productRunId: run.productRunId, sources
        });
        assertPiSessionAppendsDurable({ sessionRoot: this.catalog.sessionRootPath, sessionManager: active.sessionManager, expectedEntryIds: [id] });
        this.checkpointConversationLeaf(active);
      },
      reportMemoryRecallProgress: async (progress) => {
        const active = holder.active;
        const run = active?.currentRun;
        if (!active || !run) return;
        if (progress.recall) {
          run.memoryRecall = Object.freeze({ ...progress.recall });
          if (
            run.knowledgeObservation?.workflow === "ask"
            && progress.recall.result === "completed"
          ) {
            run.knowledgeObservation.memoryRecallUsed = true;
          }
          const persisted = await this.productRuns.read(run.productRunId);
          if (persisted && persisted.state !== "product_run_settled") {
            await this.productRuns.update(run.productRunId, {
              memoryRecall: run.memoryRecall,
              ...(run.knowledgeObservation
                ? {
                    knowledge: freezeKnowledgeObservation(
                      run.knowledgeObservation
                    )
                  }
                : {}),
              updatedAt: Math.max(persisted.updatedAt, this.now())
            });
          }
        }
        if (run.knowledgeObservation?.workflow === "ask") {
          if (run.memoryMode === "no_memory") return;
          const occurredAt = this.now();
          const previousReasoning = run.reasoningSummary;
          this.updateReasoningFromRuntimeEvent(
            active,
            run,
            {
              type: "memory_recall_progress",
              ...progress
            },
            occurredAt
          );
          if (run.reasoningSummary !== previousReasoning) {
            await this.emitRuntimeEvent(active, run, {
              type: "reasoning_summary",
              summary: cloneReasoningSummary(run.reasoningSummary)
            });
          }
          await this.setKnowledgeProgressState(
            active,
            run,
            "comparing_memory",
            progress.status
          );
          return;
        }
        await this.emitRuntimeEvent(active, run, {
          type: "memory_recall_progress",
          ...progress
        });
      },
      reportInteractionRequested: async (interaction) => {
        const active = holder.active;
        const run = active?.currentRun;
        if (!active || !run) {
          throw new PiNativeConversationRuntimeError(
            "provider_execution_unbound",
            "Question request has no bound ProductRun"
          );
        }
        if (
          interaction.conversationId !== catalog.conversationId
          || interaction.piSessionId !== catalog.piSessionId
          || interaction.turnId !== run.productRunId
        ) {
          throw new PiNativeConversationRuntimeError(
            "provider_execution_unbound",
            "Question request identity does not match the active ProductRun"
          );
        }
        await this.emitRuntimeEvent(active, run, {
          type: "interaction_requested",
          interaction
        });
      },
      reportInteractionResolved: async (record) => {
        const active = holder.active;
        const run = active?.currentRun;
        if (!active || !run) {
          throw new PiNativeConversationRuntimeError(
            "provider_execution_unbound",
            "Question result has no bound ProductRun"
          );
        }
        await this.emitRuntimeEvent(active, run, {
          type: "interaction_resolved",
          record
        });
      }
    });
    validateCreatedAgentSession(created.session, catalog, opened.sessionManager);
    validatePlanToolNames(
      created.session,
      created.planToolNames ?? []
    );
    await this.replaceAgentSessionWarnings(catalog, created.warnings ?? []);
    const diagnostics = await this.catalog.diagnostics(conversationId);
    const drafts = await this.restoreQueuedDraftsAsRestart(conversationId);
    const runs = await this.productRuns.list(conversationId);
    const last = runs.at(-1);
    const toolProductState = await this.loadToolProductState(catalog);
    const branchEntries = opened.sessionManager.getBranch();
    const projected = this.projector.projectSessionBranch({
      piSessionId: catalog.piSessionId,
      activeLeafId: opened.sessionManager.getLeafId(),
      entries: branchEntries,
      diagnostics,
      runState: last && last.state !== "product_run_settled"
        ? "interrupted"
        : terminalRunState(last),
      productRunId: last?.productRunId,
      runIdentities: runs.map(runIdentity),
      ...toolProductState,
      now: this.now()
    });
    settleFailedKnowledgeMaintenanceToolCalls(projected, runs, branchEntries);
    const projection = hideInternalSkillPromptPrefixes(this.projector.decorate(
      projected,
      await this.loadKnowledgeDecorations(catalog, branchEntries)
    ));
    const active: ActiveConversation = {
      lastPersistedLeafId: opened.restoredActiveLeafId,
      providerSettingsId: created.providerSettingsId ?? options.providerSettingsId,
      catalog,
      cwd,
      resourceKey,
      ...(options.skillName
        ? {
            skillCommandName: requireSkillCommandName(
              created.skillCommandName ?? options.skillName
            )
          }
        : {}),
      ...(created.skillPromptPrefix
        ? { skillPromptPrefix: created.skillPromptPrefix }
        : {}),
      sessionManager: opened.sessionManager,
      session: created.session,
      generationInputBudget: created.generationInputBudget,
      defaultToolNames: Object.freeze(created.session.getActiveToolNames()),
      isToolCurrentlyEnabled: created.isToolCurrentlyEnabled,
      planToolNames: Object.freeze([
        ...(created.planToolNames ?? [])
      ]),
      memoryToolNames: Object.freeze([
        ...(created.memoryToolNames ?? [])
      ]),
      externalReadToolNames: Object.freeze([
        ...(created.externalReadToolNames ?? [])
      ]),
      registeredToolNames: new Set(
        created.session.getAllTools().map((tool) => tool.name)
      ),
      unsubscribe: () => undefined,
      currentExecution: null,
      knowledgeTurnContext: null,
      currentRun: null,
      pendingSettlement: null,
      eventLane: Promise.resolve(),
      queuePersistenceLane: Promise.resolve(),
      projection: {
        ...projection,
        queuedSteering: [],
        queuedFollowUp: []
      }
    };
    void drafts;
    holder.active = active;
    active.unsubscribe = created.session.subscribe((event) => {
      const execution = active.currentRun;
      if (!execution) return;
      active.eventLane = active.eventLane.then(async () => {
        await this.handleAgentSessionEvent(active, execution, event);
      }).catch((error) => {
        execution.eventError ??= error;
      });
    });
    this.active.set(conversationId, active);
    return active;
  }

  private async resolveConversationDefaultSkill(
    skillId: string,
    catalog: Readonly<PiConversationCatalogEntry>
  ): Promise<Readonly<PiRuntimeResolvedSkill>> {
    const skills = this.options.skills;
    if (!skills?.resolveById) {
      throw new PiNativeConversationRuntimeError(
        "skill_binding_invalid",
        `会话默认 Skill ${skillId} 当前无法解析，本轮没有发送。`
      );
    }
    try {
      const resolved = await skills.resolveById({ id: skillId, catalog });
      if (resolved.id !== skillId) {
        throw new Error("resolved_skill_identity_mismatch");
      }
      return resolved;
    } catch (error) {
      throw new PiNativeConversationRuntimeError(
        "skill_binding_invalid",
        `会话默认 Skill ${skillId} 已停用、缺失或损坏，本轮没有发送。`,
        { cause: error }
      );
    }
  }

  private async completeProductRun(
    active: ActiveConversation,
    execution: ActiveProductRun,
    accepted: Readonly<PiProductRunRecord>,
    promptPromise: Promise<void>
  ): Promise<Readonly<PiProductRunRecord>> {
    try {
      let promptError: unknown = null;
      try {
        await promptPromise;
      } catch (error) {
        promptError = error;
      }
      await active.session.waitForIdle().catch((error) => {
        promptError ??= error;
      });
      await active.eventLane;
      await active.queuePersistenceLane;
      if (execution.eventError !== null) {
        throw execution.eventError instanceof Error
          ? execution.eventError
          : new Error("Pi runtime event handling failed", {
            cause: execution.eventError
          });
      }
      if (!execution.agentSettledSeen) {
        throw new PiNativeConversationRuntimeError(
          "agent_settled_missing",
          "Pi AgentSession stopped without native agent_settled",
          promptError === null ? undefined : { cause: promptError }
        );
      }

      let entries = active.sessionManager.getEntries();
      let runEntries = entries.filter(
        (entry) => !execution.baselineEntryIds.has(entry.id)
      );
      let terminalState = classifyTerminalState(
        runEntries,
        execution.abortRequested,
        promptError
      );
      if (execution.generation && this.options.generation && execution.generation.assessment) {
        const generatedAssistant = lastAssistantEntry(runEntries);
        const result = await this.options.generation.finish(execution.generation.request, execution.generation.assessment,
          terminalState === "completed" && generatedAssistant ? publicMessageText(generatedAssistant.message) : null,
          this.generationIdentity(active, execution), stage => this.setGenerationStage(active, execution, stage));
        this.appendGenerationEntry(active, GENERATION_RESULT_ENTRY, { productRunId: execution.productRunId, result });
        if (result.writeState !== "verified" && terminalState === "completed") { terminalState = "failed"; promptError = new Error(result.error ?? "生成未写入文件。"); }
        await this.setGenerationStage(active, execution, undefined, result.writeState === "verified" ? "completed" : execution.abortRequested ? "cancelled" : "failed");
      }
      const maintenance = execution.knowledgeWorkflow?.kind === "maintain"
        && execution.permission !== "read-only"
        ? execution.knowledgeWorkflow
        : null;
      const maintenanceResult = maintenance
        ? classifyKnowledgeMaintenanceResult(runEntries, undefined, collectMaintenanceReadPaths(active.sessionManager.getBranch()).filter((source) => maintenance.command.scope.mode === "global" ? knowledgePathRole(active.cwd, source) === "raw" : (maintenance.command.scope.mode === "query" ? maintenance.command.scope.candidatePaths : maintenance.command.scope.sourcePaths).includes(source)))
        : null;
      const emptyGlobal = maintenance?.command.scope.mode === "global" && maintenance.command.scope.sourcePaths?.length === 0;
      const maintenanceResultInvalid = maintenanceResult?.kind === "invalid" && !emptyGlobal;
      if (
        terminalState === "completed"
        && (
          maintenanceResultInvalid
          || maintenanceResult?.kind === "trusted_failure"
        )
      ) {
        terminalState = "failed";
      }
      const tailFailed = terminalState === "failed" && maintenanceResult?.kind === "trusted_success";
      if (tailFailed && !execution.abortRequested) terminalState = "completed";
      let maintenanceSummary = execution.commandKind === "maintain" ? maintenanceOutcome(execution, runEntries, terminalState, collectMaintenanceReadPaths(active.sessionManager.getBranch()), active.cwd) : undefined;
      if (maintenanceSummary && tailFailed) (maintenanceSummary.warnings as string[]).push(`最后回复未完成：${safeProductRunErrorCode(promptError, runEntries)}；已确认的内容结果保留。`);
      await this.closeRemainingProviderReasoning(
        active,
        execution,
        providerReasoningStatusForTerminalState(terminalState),
        this.now()
      );
      this.settleTaskPlanAfterRun(active, execution, terminalState);
      entries = active.sessionManager.getEntries();
      runEntries = entries.filter(
        (entry) => !execution.baselineEntryIds.has(entry.id)
      );
      assertPiSessionAppendsDurable({
        sessionRoot: this.catalog.sessionRootPath,
        sessionManager: active.sessionManager,
        expectedEntryIds: runEntries.map((entry) => entry.id)
      });
      persistPiActiveLeaf({
        sessionRoot: this.catalog.sessionRootPath,
        sessionManager: active.sessionManager
      });
      if (
        execution.mode === "plan"
        && !runEntries.some((entry) =>
          taskPlanFromSessionEntry(entry, active.catalog.piSessionId)
            ?.productRunId === execution.productRunId
        )
      ) {
        throw new PiNativeConversationRuntimeError(
          "projection_unsettled",
          "Plan 模式未通过 task_update 写入结构化任务计划"
        );
      }
      let assistantEntryId = lastAssistantEntryId(runEntries);
      let toolCallIds = collectToolCallIds(
        runEntries,
        execution.toolCallIds
      );

      const readWorkflow = execution.knowledgeWorkflow?.kind === "ask"
        || execution.knowledgeWorkflow?.kind === "chat"
        ? execution.knowledgeWorkflow
        : null;
      let readSourceChanged = false;
      if (readWorkflow && terminalState === "completed" && assistantEntryId) {
        const actualReferences = mergeKnowledgeReferences(
          readWorkflow.references,
          collectKnowledgeToolReferences(runEntries)
        );
        const verification = await this.options.knowledge!.verifyAskReferences({
          vaultId: active.catalog.vaultId,
          conversationId: active.catalog.conversationId,
          piSessionId: active.catalog.piSessionId,
          productRunId: execution.productRunId,
          references: actualReferences
        });
        if (verification.status === "source_changed") {
          readSourceChanged = true;
          if (execution.knowledgeObservation) {
            execution.knowledgeObservation.conflictOrFreshnessTriggered = true;
            await this.setKnowledgeProgressState(
              active,
              execution,
              "checking_conflicts_freshness",
              "active"
            );
            await this.persistKnowledgeObservation(active, execution);
          }
          readWorkflow.bufferedAssistantEvents.length = 0;
          active.sessionManager.branch(accepted.userEntryId);
          assistantEntryId = active.sessionManager.appendMessage(
            localAssistantMessage(
              active.session,
              verification.fixedResponse,
              this.now()
            )
          );
          active.session.state.messages =
            active.sessionManager.buildSessionContext().messages;
          assertPiSessionAppendsDurable({
            sessionRoot: this.catalog.sessionRootPath,
            sessionManager: active.sessionManager,
            expectedEntryIds: [assistantEntryId]
          });
          persistPiActiveLeaf({
            sessionRoot: this.catalog.sessionRootPath,
            sessionManager: active.sessionManager
          });
          entries = active.sessionManager.getEntries();
          runEntries = entries.filter(
            (entry) => !execution.baselineEntryIds.has(entry.id)
          );
          toolCallIds = [];
          await this.setKnowledgeProgressState(
            active,
            execution,
            "checking_conflicts_freshness",
            "completed"
          );
        } else {
          for (const event of readWorkflow.bufferedAssistantEvents) {
            await this.emitRuntimeEvent(active, execution, event);
          }
          readWorkflow.bufferedAssistantEvents.length = 0;
          const personalMemorySources = readWorkflow.kind === "ask"
            ? mergePersonalMemorySourceReferences(
                readWorkflow.personalMemorySources,
                collectSuccessfulAskPersonalMemoryToolSources(runEntries)
              )
            : Object.freeze([]);
          if (readWorkflow.kind === "ask") {
            readWorkflow.personalMemorySources = personalMemorySources;
          }
          if (
            readWorkflow.kind === "ask"
            || verification.references.length > 0
          ) {
            await this.options.knowledge?.recordUsage?.({
              event: {
                sourceEventId: stableId(
                  "knowledge-usage",
                  active.catalog.conversationId,
                  active.catalog.piSessionId,
                  execution.productRunId,
                  assistantEntryId,
                  "ask"
                ),
                vaultId: active.catalog.vaultId,
                conversationId: active.catalog.conversationId,
                piSessionId: active.catalog.piSessionId,
                piEntryId: assistantEntryId,
                productRunId: execution.productRunId,
                referenceIds: verification.references.map(
                  (reference) => reference.referenceId
                ),
                workflow: readWorkflow.kind === "ask" ? "ask" : "normal_read",
                producedPaths: [],
                ...(readWorkflow.kind === "ask"
                  ? {
                      personalMemorySources: personalMemorySources.map(
                        (source) => ({ ...source })
                      )
                    }
                  : {})
              },
              entries: active.sessionManager.getBranch()
            });
          }
        }
      }

      if (!readSourceChanged) {
        await this.resolveRuntimeEntryIds(active, execution, runEntries);
      }
      if (maintenance && assistantEntryId) {
        const settlement = await this.options.knowledge?.finalizeMaintenance?.({
          vaultId: active.catalog.vaultId,
          conversationId: active.catalog.conversationId,
          piSessionId: active.catalog.piSessionId,
          productRunId: execution.productRunId,
          noteReadPaths: collectMaintenanceReadPaths(runEntries),
          turnEntries: runEntries,
          scope: maintenance.command.scope,
          folderBindingsRevision: maintenance.command.folderBindingsRevision,
          terminalState,
          producedPaths: collectKnowledgeMaintenanceProducedPaths(runEntries),
          assistantEntryId,
          entries: active.sessionManager.getBranch()
        }).catch((error) => { if (maintenanceSummary) maintenanceSummary = Object.freeze({ ...maintenanceSummary, processedSourcePaths: [], pendingSourcePaths: [...new Set([...maintenanceSummary.processedSourcePaths, ...maintenanceSummary.pendingSourcePaths])], warnings: [...maintenanceSummary.warnings, `维护记录待恢复：${knowledgeErrorDetail(error)}`] }); });
        if (settlement && maintenanceSummary) maintenanceSummary = Object.freeze({ ...maintenanceSummary, processedSourcePaths: [...settlement.processedSourcePaths], pendingSourcePaths: [...settlement.pendingSourcePaths], warnings: [...maintenanceSummary.warnings, ...settlement.warnings] });
      } else if (
        !readWorkflow
        && terminalState === "completed"
        && assistantEntryId
      ) {
        const noteReadPaths = collectSuccessfulNoteReadPaths(runEntries);
        if (noteReadPaths.length > 0) {
          await this.options.knowledge?.finalizeNormalRead?.({
            vaultId: active.catalog.vaultId,
            conversationId: active.catalog.conversationId,
            piSessionId: active.catalog.piSessionId,
            productRunId: execution.productRunId,
            question: execution.requestText,
            noteReadPaths,
            assistantEntryId,
            entries: active.sessionManager.getBranch()
          });
        }
      }
      const agentSettledAt = Math.max(accepted.createdAt, this.now());
      await this.productRuns.update(execution.productRunId, {
        state: "agent_settled",
        ...(maintenanceSummary ? { maintenance: maintenanceSummary } : {}),
        assistantEntryId,
        toolCallIds,
        activeLeafId: active.sessionManager.getLeafId(),
        agentSettledAt,
        error: terminalState === "failed"
          ? safeProductRunErrorCode(promptError, runEntries)
          : undefined,
        ...(execution.knowledgeObservation
          ? { knowledge: freezeKnowledgeObservation(execution.knowledgeObservation) }
          : {}),
        updatedAt: agentSettledAt
      });
      await this.productRuns.update(execution.productRunId, {
        state: "finalizing",
        updatedAt: Math.max(agentSettledAt, this.now())
      });

      // AgentSession runtime messages are intentionally ephemeral. Pi may
      // normalize their timestamps while appending the durable Session Entry,
      // so a live message fingerprint is not a durable identity. At the native
      // agent_settled boundary the active Branch has already passed the JSONL
      // durability assertion above; rebuild exclusively from that Branch and
      // EchoInk product records instead of retaining unmatched live messages.
      active.projection = await this.rebuildProjection(
        active,
        maintenanceResultInvalid ? "failed" : "finalizing"
      );
      if (maintenanceResultInvalid) {
        settleInvalidKnowledgeMaintenanceProjection(
          active.projection,
          execution.productRunId,
          maintenanceResult.toolCallIds
        );
      }
      if (readWorkflow) {
        await this.emitRuntimeEvent(active, execution, {
          type: "agent_settled"
        });
      }
      if (
        active.projection.provisionalMessageIds.length > 0
        // The selected Branch also contains interrupted historical runs. Their
        // unresolved Tool calls remain unknown and must not block this run.
        || active.projection.pendingToolCallIds.some(toolCallId => toolCallIds.includes(toolCallId))
        || active.projection.queuedSteering.length > 0
        || active.projection.queuedFollowUp.length > 0
      ) {
        throw new PiNativeConversationRuntimeError(
          "projection_unsettled",
          "Pi Chat UI projection still contains provisional entries, Tools, or queued input"
        );
      }
      if (await this.options.hasPendingProductWork?.({
        conversationId: active.catalog.conversationId,
        piSessionId: active.catalog.piSessionId,
        productRunId: execution.productRunId
      })) {
        throw new PiNativeConversationRuntimeError(
          "projection_unsettled",
          "ProductRun still has pending Approval, Receipt, or product work"
        );
      }

      if (terminalState === "completed" && (execution.pdfTaskRequest || execution.pdfDeliveryJobs?.size) && this.options.verifyPdfTaskDelivery) {
        const noNewSourcePaths = active.sessionManager.getBranch().flatMap(entry => {
          if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== PI_KNOWLEDGE_MAINTAIN_TOOL_ID || entry.message.isError) return [];
          const envelope = knowledgeMaintenanceEnvelopeFromToolResult(entry.message);
          const details = safeRecord(entry.message.details);
          return envelope?.status === "noop" && Array.isArray(details?.processedSourcePaths) ? details.processedSourcePaths.filter((value): value is string => typeof value === "string") : [];
        });
        try {
          if (execution.pdfTaskRequest) await this.options.verifyPdfTaskDelivery(execution.pdfTaskRequest, noNewSourcePaths);
          for (const jobId of execution.pdfDeliveryJobs ?? []) if (jobId !== execution.pdfTaskRequest?.jobId) await this.options.verifyPdfTaskDelivery(jobId, noNewSourcePaths);
        } catch (error) {
          // Missing selected outputs are an ordinary failed task, not a broken settlement.
          // Persist a terminal run so explicit recovery can continue it normally.
          terminalState = "failed"; promptError = error;
          execution.interruption = { at: this.now(), reason: "run_failed", stage: "核对 PDF 成果",
            detail: error instanceof Error ? error.message.slice(0, 1000) : "PDF 成果尚未核实，已有文件保留。" };
          this.settleTaskPlanAfterRun(active, execution, terminalState);
        }
      }

      await this.closeAndPersistReasoningSummary(
        active,
        execution,
        reasoningSummaryTerminalStatus(
          terminalState,
          execution.abortRequested
        ),
        this.now()
      );
      const settledAt = Math.max(agentSettledAt, this.now());
      const settled = await this.productRuns.update(
        execution.productRunId,
        {
          state: "product_run_settled",
          terminalState,
          ...(terminalState !== "completed" ? { interruption: execution.interruption ?? {
            at: settledAt, reason: terminalState === "failed" ? "run_failed" as const : "process_unknown" as const,
            stage: taskInterruptionStage(active), ...(terminalState === "failed" ? { detail: safeProductRunErrorCode(promptError, runEntries) } : {})
          } } : {}),
          assistantEntryId,
          toolCallIds,
          activeLeafId: active.sessionManager.getLeafId(),
          settledAt,
          error: terminalState === "failed"
            ? safeProductRunErrorCode(promptError, runEntries)
            : undefined,
          updatedAt: settledAt
        }
      );
      if (
        terminalState === "completed"
        && execution.mode !== "plan"
        && execution.commandKind === "chat"
        && execution.selectedSkillIds.length
      ) {
        for (const skillId of execution.selectedSkillIds) {
          await this.options.skills?.recordUse(skillId, settledAt).catch(async () => {
            await this.appendRuntimeResourceWarning(
              active,
              execution,
              "skill_usage_record_failed"
            );
          });
        }
      }
      const reusableCapabilities = Object.freeze([
        ...execution.selectedSkillIds.map((id) => `skill:${id}`),
        ...execution.successfulCapabilityIds
      ].sort());
      if (
        this.options.skills
        && !execution.generation
        && terminalState === "completed"
        && execution.mode !== "plan"
        && execution.commandKind === "chat"
      ) {
        void this.options.skills.reviewCompletedTask({
          productRunId: execution.productRunId,
          request: execution.requestText,
          result: lastAssistantEntry(runEntries)
            ? publicMessageText(lastAssistantEntry(runEntries)!.message).trim()
            : "",
          terminalState,
          existingCapabilityIds: reusableCapabilities
        }).catch(async () => {
          await this.appendRuntimeResourceWarning(
            active,
            execution,
            "skill_review_failed"
          );
        }).catch(() => undefined);
      }
      if (
        execution.memoryMode === "normal"
        && terminalState !== "cancelled"
        && assistantEntryId
        && this.options.recordDreamExperience
      ) {
        const experience = buildDreamPublicExperienceFromRun({
          conversationId: active.catalog.conversationId,
          productRunId: execution.productRunId,
          userEntryId: accepted.userEntryId,
          assistantEntryId,
          terminalState,
          occurredAt: settledAt,
          entries: runEntries
        });
        if (experience) {
          try {
            await this.options.recordDreamExperience(experience);
          } catch {
            await this.catalog.appendDiagnostic({
              diagnosticId: runtimeInterruptedDiagnosticId(
                active.catalog.conversationId,
                active.catalog.piSessionId,
                `${execution.productRunId}:dream-experience`
              ),
              conversationId: active.catalog.conversationId,
              piSessionId: active.catalog.piSessionId,
              code: "runtime_resource_warning",
              message: "dream_experience_capture_failed",
              createdAt: this.now()
            }).catch(() => undefined);
          }
        }
      }
      await this.emitRuntimeEvent(active, execution, {
        type: "product_run_settled",
        terminalState,
        assistantEntryId
      });
      return settled;
    } catch (settlementError) {
      let providerReasoningCloseError: unknown = null;
      try {
        await this.closeRemainingProviderReasoning(
          active,
          execution,
          execution.abortRequested ? "cancelled" : "failed",
          this.now()
        );
      } catch (error) {
        providerReasoningCloseError = error;
      }
      let reasoningCloseError: unknown = null;
      if (!execution.reasoningTerminalEntryId) {
        try {
          await this.closeAndPersistReasoningSummary(
            active,
            execution,
            execution.abortRequested ? "cancelled" : "failed",
            this.now()
          );
        } catch (error) {
          reasoningCloseError = error;
        }
      }
      const diagnostic: PiConversationDiagnostic = {
        diagnosticId: runtimeInterruptedDiagnosticId(
          active.catalog.conversationId,
          active.catalog.piSessionId,
          execution.productRunId
        ),
        conversationId: active.catalog.conversationId,
        piSessionId: active.catalog.piSessionId,
        code: "runtime_interrupted",
        message: safePersistedRuntimeErrorCode(settlementError),
        createdAt: this.now()
      };
      try {
        await this.catalog.appendDiagnostic(diagnostic);
      } catch (diagnosticError) {
        throw new AggregateError(
          [
            settlementError,
            ...(providerReasoningCloseError === null
              ? []
              : [providerReasoningCloseError]),
            ...(reasoningCloseError === null ? [] : [reasoningCloseError]),
            diagnosticError
          ],
          "ProductRun settlement failed and its diagnostic could not be persisted"
        );
      }
      if (
        providerReasoningCloseError !== null
        || reasoningCloseError !== null
      ) {
        throw new AggregateError(
          [
            settlementError,
            ...(providerReasoningCloseError === null
              ? []
              : [providerReasoningCloseError]),
            ...(reasoningCloseError === null ? [] : [reasoningCloseError])
          ],
          "ProductRun settlement and Reasoning closeout failed"
        );
      }
      throw settlementError;
    } finally {
      this.finishProductRunRuntimeState(active, execution);
    }
  }

  private async appendRuntimeResourceWarning(
    active: ActiveConversation,
    execution: ActiveProductRun,
    message: string
  ): Promise<void> {
    await this.catalog.appendDiagnostic({
      diagnosticId: runtimeInterruptedDiagnosticId(
        active.catalog.conversationId,
        active.catalog.piSessionId,
        `${execution.productRunId}:${message}`
      ),
      conversationId: active.catalog.conversationId,
      piSessionId: active.catalog.piSessionId,
      code: "runtime_resource_warning",
      message,
      createdAt: this.now()
    }).catch(() => undefined);
  }

  private async appendProductRunStartFailureDiagnostic(
    active: ActiveConversation,
    execution: ActiveProductRun,
    stage: PiProductRunStartFailureStage,
    error: unknown
  ): Promise<void> {
    const message = [
      "pi_native_start_failed",
      stage,
      safeProductRunStartFailureCode(error)
    ].join(":");
    await this.catalog.appendDiagnostic({
      diagnosticId: runtimeInterruptedDiagnosticId(
        active.catalog.conversationId,
        active.catalog.piSessionId,
        `${execution.productRunId}:start:${stage}`
      ),
      conversationId: active.catalog.conversationId,
      piSessionId: active.catalog.piSessionId,
      code: "runtime_interrupted",
      message,
      createdAt: this.now()
    }).catch(() => undefined);
  }

  private async handleAgentSessionEvent(
    active: ActiveConversation,
    execution: ActiveProductRun,
    event: AgentSessionEvent
  ): Promise<void> {
    if (["message_end", "tool_execution_start", "tool_execution_end", "compaction_end", "agent_settled"].includes(event.type)) this.checkpointConversationLeaf(active);
    if (execution.generation && (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") && runtimeMessageRole(event.message) === "assistant") {
      if (event.type === "message_end" && publicMessageText(event.message).trim()) await this.observeFirstAssistantText(active, execution);
      return;
    }
    switch (event.type) {
      case "message_start":
        await this.emitOrBufferAskAssistantEvent(active, execution, event.message, {
          type: "message_start",
          messageKey: messageKey(execution, event.message),
          role: runtimeMessageRole(event.message)
        });
        break;
      case "message_update": {
        const assistantEvent = event.assistantMessageEvent;
        const key = messageKey(execution, event.message);
        if (assistantEvent.type === "thinking_start") {
          this.beginProviderReasoningBlock(
            execution,
            key,
            assistantEvent.contentIndex,
            assistantEvent.partial,
            this.now()
          );
          break;
        }
        if (assistantEvent.type === "thinking_delta") {
          await this.appendProviderReasoningDelta(
            active,
            execution,
            key,
            assistantEvent
          );
          break;
        }
        if (assistantEvent.type === "thinking_end") {
          await this.endProviderReasoningBlock(
            active,
            execution,
            key,
            assistantEvent
          );
          break;
        }
        const delta = assistantEvent.type === "text_delta"
          ? assistantEvent.delta
          : "";
        if (delta) {
          if (
            runtimeMessageRole(event.message) === "assistant"
            && delta.trim()
          ) {
            await this.observeFirstAssistantText(active, execution);
          }
          await this.emitOrBufferAskAssistantEvent(active, execution, event.message, {
            type: "message_update",
            messageKey: key,
            textDelta: delta
          });
        }
        break;
      }
      case "message_end": {
        const key = messageKey(execution, event.message);
        await this.closeProviderReasoningForMessage(
          active,
          execution,
          key,
          event.message,
          this.now()
        );
        const text = publicMessageText(event.message);
        if (
          runtimeMessageRole(event.message) === "assistant"
          && text.trim()
        ) {
          await this.observeFirstAssistantText(active, execution);
        }
        await this.emitOrBufferAskAssistantEvent(active, execution, event.message, {
          type: "message_end",
          messageKey: key,
          role: runtimeMessageRole(event.message),
          text,
          status: runtimeMessageStatus(event.message)
        });
        break;
      }
      case "tool_execution_start":
        this.finishProviderWait(execution);
        execution.toolCallIds.add(event.toolCallId);
        await this.beginKnowledgeToolProgress(
          active,
          execution,
          event.toolCallId,
          event.toolName,
          event.args
        );
        await this.emitRuntimeEvent(active, execution, {
          type: "tool_execution_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          ...(knowledgeToolIsPrivacySafe(execution, event.toolName)
            ? { privacySafe: true }
            : {}),
          args: runtimeToolPayloadForProjection(
            execution,
            event.toolName,
            event.args
          )
        });
        break;
      case "tool_execution_update":
        execution.toolCallIds.add(event.toolCallId);
        await this.emitRuntimeEvent(active, execution, {
          type: "tool_execution_update",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          ...(knowledgeToolIsPrivacySafe(execution, event.toolName)
            ? { privacySafe: true }
            : {}),
          update: runtimeToolPayloadForProjection(
            execution,
            event.toolName,
            event.partialResult
          )
        });
        break;
      case "tool_execution_end":
        execution.toolCallIds.add(event.toolCallId);
        await this.observeKnowledgeToolResult(
          active,
          execution,
          event.toolName,
          event.result,
          event.isError
        );
        await this.emitRuntimeEvent(active, execution, {
          type: "tool_execution_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          ...(knowledgeToolIsPrivacySafe(execution, event.toolName)
            ? { privacySafe: true }
            : {}),
          result: runtimeToolPayloadForProjection(
            execution,
            event.toolName,
            event.result,
            event.isError
          ),
          isError: event.isError
        });
        await this.endKnowledgeToolProgress(
          active,
          execution,
          event.toolCallId
        );
        break;
      case "compaction_start":
        await this.emitRuntimeEvent(active, execution, {
          type: "compaction_start",
          reason: event.reason
        });
        break;
      case "compaction_end":
        await this.emitRuntimeEvent(active, execution, {
          type: "compaction_end",
          reason: event.reason,
          entryId: lastEntryOfType(
            active.sessionManager.getEntries(),
            "compaction"
          )?.id,
          aborted: event.aborted,
          willRetry: event.willRetry,
          error: event.errorMessage
        });
        break;
      case "queue_update":
        active.queuePersistenceLane = active.queuePersistenceLane.then(
          async () => await this.persistQueueDrafts(
            active,
            execution,
            event.steering,
            event.followUp
          )
        );
        await this.emitRuntimeEvent(active, execution, {
          type: "queue_update",
          steering: event.steering,
          followUp: event.followUp
        });
        break;
      case "agent_end":
        await this.emitRuntimeEvent(active, execution, {
          type: "agent_end",
          willRetry: event.willRetry
        });
        break;
      case "agent_settled":
        execution.agentSettledSeen = true;
        if (execution.knowledgeWorkflow?.kind !== "ask"
          && execution.knowledgeWorkflow?.kind !== "chat") {
          await this.emitRuntimeEvent(active, execution, {
            type: "agent_settled"
          });
        }
        break;
    }
  }

  private beginProviderReasoningBlock(
    execution: ActiveProductRun,
    messageKeyValue: string,
    contentIndex: number,
    partial: AssistantMessage,
    observedAt: number
  ): void {
    const key = providerReasoningBlockKey(messageKeyValue, contentIndex);
    if (execution.providerReasoningBlocks.has(key)) return;
    const content = providerThinkingContentAt(partial, contentIndex);
    execution.providerReasoningBlocks.set(key, {
      messageKey: messageKeyValue,
      contentIndex,
      reasoningId: providerReasoningSegmentId(
        execution.productRunId,
        messageKeyValue,
        contentIndex
      ),
      startedAt: observedAt,
      ...providerReasoningMessageTimestamp(partial, observedAt),
      text: "",
      exposed: false,
      redacted: content?.redacted === true
    });
  }

  private async appendProviderReasoningDelta(
    active: ActiveConversation,
    execution: ActiveProductRun,
    messageKeyValue: string,
    event: Extract<
      Extract<AgentSessionEvent, { type: "message_update" }>["assistantMessageEvent"],
      { type: "thinking_delta" }
    >
  ): Promise<void> {
    const observedAt = this.now();
    const key = providerReasoningBlockKey(
      messageKeyValue,
      event.contentIndex
    );
    const content = providerThinkingContentAt(
      event.partial,
      event.contentIndex
    );
    let block = execution.providerReasoningBlocks.get(key);
    if (!block) {
      block = {
        messageKey: messageKeyValue,
        contentIndex: event.contentIndex,
        reasoningId: providerReasoningSegmentId(
          execution.productRunId,
          messageKeyValue,
          event.contentIndex
        ),
        startedAt: observedAt,
        ...providerReasoningMessageTimestamp(event.partial, observedAt),
        text: "",
        exposed: false,
        redacted: content?.redacted === true
      };
      execution.providerReasoningBlocks.set(key, block);
    }
    if (content?.redacted === true) {
      block.redacted = true;
      await this.discardProviderReasoningBlock(
        active,
        execution,
        key,
        block,
        observedAt
      );
      return;
    }
    if (block.redacted || !event.delta) return;
    this.finishProviderWait(execution);
    block.text += event.delta;
    if (!block.exposed) {
      if (!block.text.trim()) return;
      block.exposed = true;
      beginPublicProviderReasoning(execution, block);
      await this.emitRuntimeEvent(active, execution, {
        type: "provider_reasoning_start",
        messageKey: messageKeyValue,
        reasoningId: block.reasoningId
      }, block.startedAt);
      await this.emitRuntimeEvent(active, execution, {
        type: "provider_reasoning_delta",
        messageKey: messageKeyValue,
        reasoningId: block.reasoningId,
        textDelta: block.text
      }, observedAt);
      return;
    }
    await this.emitRuntimeEvent(active, execution, {
      type: "provider_reasoning_delta",
      messageKey: messageKeyValue,
      reasoningId: block.reasoningId,
      textDelta: event.delta
    }, observedAt);
  }

  private async endProviderReasoningBlock(
    active: ActiveConversation,
    execution: ActiveProductRun,
    messageKeyValue: string,
    event: Extract<
      Extract<AgentSessionEvent, { type: "message_update" }>["assistantMessageEvent"],
      { type: "thinking_end" }
    >
  ): Promise<void> {
    const observedAt = this.now();
    const key = providerReasoningBlockKey(
      messageKeyValue,
      event.contentIndex
    );
    const content = providerThinkingContentAt(
      event.partial,
      event.contentIndex
    );
    const block = execution.providerReasoningBlocks.get(key) ?? {
      messageKey: messageKeyValue,
      contentIndex: event.contentIndex,
      reasoningId: providerReasoningSegmentId(
        execution.productRunId,
        messageKeyValue,
        event.contentIndex
      ),
      startedAt: observedAt,
      ...providerReasoningMessageTimestamp(event.partial, observedAt),
      text: "",
      exposed: false,
      redacted: content?.redacted === true
    };
    execution.providerReasoningBlocks.set(key, block);
    if (content?.redacted === true || block.redacted) {
      await this.discardProviderReasoningBlock(
        active,
        execution,
        key,
        block,
        observedAt
      );
      return;
    }
    await this.finishProviderReasoningBlock(
      active,
      execution,
      key,
      block,
      event.content.trim() ? event.content : block.text,
      "completed",
      observedAt
    );
  }

  private async closeProviderReasoningForMessage(
    active: ActiveConversation,
    execution: ActiveProductRun,
    messageKeyValue: string,
    message: AgentMessage,
    observedAt: number
  ): Promise<void> {
    const status = providerReasoningStatusForMessage(message);
    for (const [key, block] of [...execution.providerReasoningBlocks]) {
      if (block.messageKey !== messageKeyValue) continue;
      const content = isAssistantMessage(message)
        ? providerThinkingContentAt(message, block.contentIndex)
        : null;
      if (content?.redacted === true || block.redacted) {
        await this.discardProviderReasoningBlock(
          active,
          execution,
          key,
          block,
          observedAt
        );
        continue;
      }
      await this.finishProviderReasoningBlock(
        active,
        execution,
        key,
        block,
        content?.thinking.trim() ? content.thinking : block.text,
        status,
        observedAt
      );
    }
  }

  private async closeRemainingProviderReasoning(
    active: ActiveConversation,
    execution: ActiveProductRun,
    status: Extract<
      PiChatRuntimeEvent,
      { type: "provider_reasoning_end" }
    >["status"],
    observedAt: number
  ): Promise<void> {
    for (const [key, block] of [...execution.providerReasoningBlocks]) {
      if (block.redacted) {
        await this.discardProviderReasoningBlock(
          active,
          execution,
          key,
          block,
          observedAt
        );
        continue;
      }
      await this.finishProviderReasoningBlock(
        active,
        execution,
        key,
        block,
        block.text,
        status,
        observedAt
      );
    }
  }

  private async finishProviderReasoningBlock(
    active: ActiveConversation,
    execution: ActiveProductRun,
    key: string,
    block: MutableProviderReasoningBlock,
    finalText: string,
    status: Extract<
      PiChatRuntimeEvent,
      { type: "provider_reasoning_end" }
    >["status"],
    observedAt: number
  ): Promise<void> {
    if (!block.exposed && !finalText.trim()) {
      execution.providerReasoningBlocks.delete(key);
      return;
    }
    if (!block.exposed) {
      block.exposed = true;
      beginPublicProviderReasoning(execution, block);
      await this.emitRuntimeEvent(active, execution, {
        type: "provider_reasoning_start",
        messageKey: block.messageKey,
        reasoningId: block.reasoningId
      }, block.startedAt);
    }
    execution.providerReasoningBlocks.delete(key);
    await this.emitRuntimeEvent(active, execution, {
      type: "provider_reasoning_end",
      messageKey: block.messageKey,
      reasoningId: block.reasoningId,
      text: finalText,
      status
    }, observedAt);
  }

  private async discardProviderReasoningBlock(
    active: ActiveConversation,
    execution: ActiveProductRun,
    key: string,
    block: MutableProviderReasoningBlock,
    observedAt: number
  ): Promise<void> {
    execution.providerReasoningBlocks.delete(key);
    if (!block.exposed) return;
    await this.emitRuntimeEvent(active, execution, {
      type: "provider_reasoning_end",
      messageKey: block.messageKey,
      reasoningId: block.reasoningId,
      text: "",
      status: "interrupted"
    }, observedAt);
  }

  private finishProviderWait(
    execution: ActiveProductRun,
    status: EchoInkReasoningActivityStatus = "completed"
  ): void {
    if (execution.providerWaitTimer !== undefined) {
      clearInterval(execution.providerWaitTimer);
      delete execution.providerWaitTimer;
    }
    const provider = execution.reasoningSummary.activities.find((activity) =>
      activity.id === "provider" && activity.status === "active"
    );
    if (provider) this.updateReasoningActivitySafely(execution, {
      ...provider, status, updatedAt: Math.max(provider.updatedAt, this.now())
    });
  }

  private async observeFirstAssistantText(
    active: ActiveConversation,
    execution: ActiveProductRun
  ): Promise<void> {
    if (execution.firstAssistantTextSeen) return;
    this.finishProviderWait(execution);
    execution.firstAssistantTextSeen = true;
    const observedAt = this.now();
    execution.reasoningSummary = completeReasoningAtFirstText({
      summary: execution.reasoningSummary,
      observedAt
    });
    await this.emitRuntimeEvent(active, execution, {
      type: "reasoning_summary",
      summary: cloneReasoningSummary(execution.reasoningSummary)
    });
    if (
      execution.knowledgeObservation
      && execution.providerStartedAt !== undefined
    ) {
      execution.knowledgeObservation.modelFirstTextLatencyMs = Math.max(
        0,
        observedAt - execution.providerStartedAt
      );
      await this.persistKnowledgeObservation(active, execution);
    }
  }

  private async beginKnowledgeToolProgress(
    active: ActiveConversation,
    execution: ActiveProductRun,
    toolCallId: string,
    toolName: string,
    args: unknown
  ): Promise<void> {
    const observation = execution.knowledgeObservation;
    if (!observation) return;
    const stage = knowledgeToolProgressStage(
      execution,
      toolName,
      args,
      active.externalReadToolNames
    );
    if (!stage) return;
    if (
      toolName === PI_KNOWLEDGE_MAINTAIN_TOOL_ID
      && execution.knowledgeProgressDepth.has("refining_knowledge")
    ) {
      await this.setKnowledgeProgressState(
        active,
        execution,
        "refining_knowledge",
        "completed"
      );
    }
    execution.knowledgeToolStages.set(toolCallId, stage);
    const depth = execution.knowledgeProgressDepth.get(stage) ?? 0;
    execution.knowledgeProgressDepth.set(stage, depth + 1);
    if (toolName === "memory_search") observation.memorySearchUsed = true;
    if (toolName === "memory_read") observation.memoryReadUsed = true;
    if (active.externalReadToolNames.includes(toolName)) {
      observation.conflictOrFreshnessTriggered = true;
    }
    if (depth === 0) {
      await this.emitRuntimeEvent(active, execution, {
        type: "knowledge_progress",
        status: "active",
        stage
      });
    }
    await this.persistKnowledgeObservation(active, execution);
  }

  private async observeKnowledgeToolResult(
    active: ActiveConversation,
    execution: ActiveProductRun,
    toolName: string,
    result: unknown,
    isError: boolean
  ): Promise<void> {
    const observation = execution.knowledgeObservation;
    if (!observation) return;
    const details = safeAgentToolResultDetails(result);
    if (
      toolName === "knowledge_search"
      && !isError
      && details?.source === "echoink-knowledge"
      && details.status === "completed"
    ) {
      const total = safeNonNegativeInteger(details.total);
      const returned = safeNonNegativeInteger(details.returned);
      const remaining = safeNonNegativeInteger(details.remaining);
      const elapsedMs = safeNonNegativeInteger(details.elapsedMs);
      const continuation = details.continuation === true;
      if (
        total !== null
        && returned !== null
        && remaining !== null
        && elapsedMs !== null
        && returned + remaining <= total
      ) {
        observation.localRetrievalElapsedMs += elapsedMs;
        if (continuation && observation.candidates > 0) {
          observation.continuationCount += 1;
          observation.returned = Math.min(
            observation.candidates,
            observation.returned + returned
          );
          observation.remaining = Math.max(
            0,
            observation.remaining - returned
          );
        } else {
          observation.candidates += total;
          observation.returned += returned;
          observation.remaining += remaining;
        }
        observation.hasMore = observation.remaining > 0;
        observation.exhausted = !observation.hasMore;
      }
    }
    if (toolName === "knowledge_read" && !isError) {
      observation.knowledgeReadCount += 1;
    }
    const sourceChanged = details?.errorCode === "knowledge_source_changed";
    if (sourceChanged) {
      observation.conflictOrFreshnessTriggered = true;
      await this.setKnowledgeProgressState(
        active,
        execution,
        "checking_conflicts_freshness",
        "active"
      );
    }
    if (toolName === PI_KNOWLEDGE_MAINTAIN_TOOL_ID && details) {
      const protocolVersion = safeVersionToken(details.protocolVersion);
      const preferenceProfileVersion = safeVersionToken(
        details.preferenceProfileVersion
      );
      const preferenceState = details.preferenceState === "default"
        || details.preferenceState === "custom"
        ? details.preferenceState
        : null;
      if (protocolVersion) observation.protocolVersion = protocolVersion;
      if (preferenceProfileVersion) {
        observation.preferenceProfileVersion = preferenceProfileVersion;
      }
      if (preferenceState) observation.preferenceState = preferenceState;
      if (details.errorCode === "preview_stale") {
        observation.conflictOrFreshnessTriggered = true;
        await this.setKnowledgeProgressState(
          active,
          execution,
          "checking_conflicts_freshness",
          "active"
        );
      }
    }
    await this.persistKnowledgeObservation(active, execution);
    if (sourceChanged || details?.errorCode === "preview_stale") {
      await this.setKnowledgeProgressState(
        active,
        execution,
        "checking_conflicts_freshness",
        "completed"
      );
    }
  }

  private async endKnowledgeToolProgress(
    active: ActiveConversation,
    execution: ActiveProductRun,
    toolCallId: string
  ): Promise<void> {
    const stage = execution.knowledgeToolStages.get(toolCallId);
    if (!stage) return;
    execution.knowledgeToolStages.delete(toolCallId);
    const depth = execution.knowledgeProgressDepth.get(stage) ?? 0;
    if (depth <= 1) {
      execution.knowledgeProgressDepth.delete(stage);
      await this.emitRuntimeEvent(active, execution, {
        type: "knowledge_progress",
        status: "completed",
        stage
      });
      return;
    }
    execution.knowledgeProgressDepth.set(stage, depth - 1);
  }

  private async setKnowledgeProgressState(
    active: ActiveConversation,
    execution: ActiveProductRun,
    stage: Extract<
      PiChatRuntimeEvent,
      { type: "knowledge_progress" }
    >["stage"],
    status: "active" | "completed"
  ): Promise<void> {
    const activeDepth = execution.knowledgeProgressDepth.get(stage) ?? 0;
    if (status === "active") {
      if (activeDepth > 0) return;
      execution.knowledgeProgressDepth.set(stage, 1);
    } else {
      if (activeDepth === 0) return;
      execution.knowledgeProgressDepth.delete(stage);
    }
    await this.emitRuntimeEvent(active, execution, {
      type: "knowledge_progress",
      status,
      stage
    });
  }

  private async persistKnowledgeObservation(
    _active: ActiveConversation,
    execution: ActiveProductRun
  ): Promise<void> {
    if (!execution.knowledgeObservation) return;
    const persisted = await this.productRuns.read(execution.productRunId);
    if (!persisted || persisted.state === "product_run_settled") return;
    await this.productRuns.update(execution.productRunId, {
      knowledge: freezeKnowledgeObservation(execution.knowledgeObservation),
      updatedAt: Math.max(persisted.updatedAt, this.now())
    });
  }

  private async emitOrBufferAskAssistantEvent(
    active: ActiveConversation,
    execution: ActiveProductRun,
    message: AgentMessage,
    event: PiChatRuntimeEventPayload
  ): Promise<void> {
    const workflow = execution.knowledgeWorkflow;
    if ((workflow?.kind === "ask" || workflow?.kind === "chat")
      && runtimeMessageRole(message) === "assistant") {
      workflow.bufferedAssistantEvents.push(structuredClone(event));
      return;
    }
    await this.emitRuntimeEvent(active, execution, event);
  }

  private async closeAndPersistReasoningSummary(
    active: ActiveConversation,
    execution: ActiveProductRun,
    status: Exclude<EchoInkReasoningSummaryStatus, "running">,
    terminalAt: number
  ): Promise<void> {
    this.finishProviderWait(execution, status === "completed" ? "completed" : status);
    if (execution.reasoningTerminalEntryId) return;
    const plan = activeTaskPlanFromBranch(active.sessionManager.getBranch());
    if (plan) this.updateReasoningTaskPlan(execution, plan, terminalAt);
    execution.reasoningSummary = closeReasoningSummary({
      summary: execution.reasoningSummary,
      status,
      terminalAt
    });
    execution.reasoningTerminalEntryId = appendReasoningSummaryEntry(
      active.sessionManager,
      execution.reasoningSummary
    );
    assertPiSessionAppendsDurable({
      sessionRoot: this.catalog.sessionRootPath,
      sessionManager: active.sessionManager,
      expectedEntryIds: [execution.reasoningTerminalEntryId]
    });
    persistPiActiveLeaf({
      sessionRoot: this.catalog.sessionRootPath,
      sessionManager: active.sessionManager
    });
    await this.emitRuntimeEvent(active, execution, {
      type: "reasoning_summary",
      summary: cloneReasoningSummary(execution.reasoningSummary)
    });
    active.projection = await this.rebuildProjection(
      active,
      active.projection.runState
    );
    const maintenanceResult = execution.knowledgeWorkflow?.kind === "maintain"
      && execution.permission !== "read-only"
      ? classifyKnowledgeMaintenanceResult(
          active.sessionManager.getEntries().filter(
            (entry) => !execution.baselineEntryIds.has(entry.id)
          )
        )
      : null;
    if (maintenanceResult?.kind === "invalid") {
      settleInvalidKnowledgeMaintenanceProjection(
        active.projection,
        execution.productRunId,
        maintenanceResult.toolCallIds
      );
    }
  }

  private queueReasoningActivity(
    active: ActiveConversation,
    execution: ActiveProductRun,
    activity: Readonly<EchoInkReasoningActivity>
  ): void {
    const previous = execution.reasoningSummary;
    this.updateReasoningActivitySafely(execution, activity);
    if (execution.reasoningSummary === previous) return;
    const summary = cloneReasoningSummary(execution.reasoningSummary);
    active.eventLane = active.eventLane.then(async () => {
      await this.emitRuntimeEvent(active, execution, {
        type: "reasoning_summary",
        summary
      });
    }).catch((error) => {
      execution.eventError ??= error;
    });
  }

  private updateReasoningActivitySafely(
    execution: ActiveProductRun,
    activity: Readonly<EchoInkReasoningActivity>
  ): void {
    try {
      execution.reasoningSummary = updateReasoningActivity({
        summary: execution.reasoningSummary,
        activity
      });
    } catch {
      // Reasoning is display-only. An invalid bounded observation is omitted
      // instead of breaking the underlying Agent/Tool execution.
    }
  }

  private updateReasoningFromRuntimeEvent(
    active: ActiveConversation,
    execution: ActiveProductRun,
    event: PiChatRuntimeEventPayload,
    occurredAt: number
  ): void {
    if (event.type === "knowledge_progress") {
      // Tool calls already have their own stable rows and per-call result counts.
      // This row describes only the initial retrieval, never the turn aggregate.
      const retrieval = event.stage === "searching" || event.stage === "continuing_search"
        || event.stage === "reading_knowledge";
      if (event.stage === "comparing_memory" || execution.knowledgeToolStages.size > 0) return;
      if (retrieval && execution.reasoningSummary.activities.some((activity) =>
        activity.id === "knowledge:retrieval" && activity.status === "completed"
      )) return;
      const observation = execution.knowledgeObservation;
      const counts = observation && observation.candidates > 0
        ? {
            current: Math.min(observation.returned, observation.candidates),
            total: observation.candidates,
            completed: Math.min(observation.returned, observation.candidates)
          }
        : {};
      this.updateReasoningActivitySafely(execution, {
        id: retrieval ? "knowledge:retrieval" : `knowledge:${event.stage}`,
        kind: "knowledge",
        status: event.status === "active" ? "active" : "completed",
        stage: event.stage,
        startedAt: occurredAt,
        updatedAt: occurredAt,
        ...counts
      });
      return;
    }
    if (event.type === "memory_recall_progress") {
      const recall = event.recall;
      const counts = recall
        ? {
            current: Math.min(recall.injected, recall.candidates),
            total: recall.candidates,
            completed: Math.min(recall.injected, recall.candidates)
          }
        : {};
      this.updateReasoningActivitySafely(execution, {
        id: "memory:recall",
        kind: "memory",
        status: event.status === "active" ? "active" : "completed",
        stage: event.stage,
        startedAt: occurredAt,
        updatedAt: occurredAt,
        ...counts
      });
      return;
    }
    if (event.type === "tool_execution_start") {
      if (!active.registeredToolNames.has(event.toolName)) return;
      if (event.toolName === PI_USER_QUESTION_TOOL_ID) return;
      this.updateReasoningActivitySafely(execution, {
        id: stableId("reasoning-tool", event.toolCallId),
        kind: "tool",
        status: "active",
        name: event.toolName,
        startedAt: occurredAt,
        updatedAt: occurredAt
      });
      return;
    }
    if (event.type !== "tool_execution_end") return;
    if (event.toolName === PI_USER_QUESTION_TOOL_ID) return;
    if (active.registeredToolNames.has(event.toolName)) {
      if (!event.isError && !reasoningToolWasCancelled(event.result)) {
        execution.successfulCapabilityIds.add(event.toolName);
      }
      this.updateReasoningActivitySafely(execution, {
        id: stableId("reasoning-tool", event.toolCallId),
        kind: "tool",
        status: reasoningToolWasCancelled(event.result)
          ? "cancelled"
          : event.isError
            ? "failed"
            : "completed",
        name: event.toolName,
        startedAt: occurredAt,
        updatedAt: occurredAt
      });
    }
    const plan = taskPlanFromToolResult(event.result);
    if (plan) this.updateReasoningTaskPlan(execution, plan, occurredAt);
  }

  private updateReasoningTaskPlan(
    execution: ActiveProductRun,
    plan: Readonly<EchoInkTaskPlanSnapshot>,
    occurredAt: number
  ): void {
    const progress = taskPlanProgress(plan);
    this.updateReasoningActivitySafely(execution, {
      id: stableId("reasoning-task", plan.planId),
      kind: "task",
      status: reasoningTaskActivityStatus(plan.status),
      stage: plan.status,
      startedAt: occurredAt,
      updatedAt: occurredAt,
      current: progress.current,
      total: progress.total,
      completed: progress.completed
    });
  }

  private async emitRuntimeEvent(
    active: ActiveConversation,
    execution: ActiveProductRun,
    event: PiChatRuntimeEventPayload,
    observedAt?: number
  ): Promise<void> {
    const occurredAt = typeof observedAt === "number"
      && Number.isFinite(observedAt)
      ? observedAt
      : this.now();
    const previousReasoning = execution.reasoningSummary;
    if (event.type !== "reasoning_summary") {
      this.updateReasoningFromRuntimeEvent(
        active,
        execution,
        event,
        occurredAt
      );
    }
    const runtimeEvent = {
      ...event,
      productRunId: execution.productRunId,
      conversationId: active.catalog.conversationId,
      piSessionId: active.catalog.piSessionId,
      activeLeafId: active.sessionManager.getLeafId(),
      occurredAt
    };
    const publish = async (published: Readonly<PiChatRuntimeEvent>) => {
      active.projection = this.projector.projectRuntimeEvent({
        current: active.projection,
        event: published
      });
      hideInternalSkillPromptPrefixes(active.projection);
      if (published.type.startsWith("tool_execution_")) {
        active.projection = this.projector.decorateToolProductState(
          active.projection,
          await this.loadToolProductState(
            active.catalog,
            execution.productRunId
          )
        );
      }
      await execution.channel.emit(published);
    };
    await publish(runtimeEvent);
    if (
      event.type !== "reasoning_summary"
      && execution.reasoningSummary !== previousReasoning
    ) {
      await publish({
        type: "reasoning_summary",
        productRunId: execution.productRunId,
        conversationId: active.catalog.conversationId,
        piSessionId: active.catalog.piSessionId,
        activeLeafId: active.sessionManager.getLeafId(),
        occurredAt,
        summary: cloneReasoningSummary(execution.reasoningSummary)
      });
    }
  }

  private async resolveRuntimeEntryIds(
    active: ActiveConversation,
    execution: ActiveProductRun,
    entries: readonly SessionEntry[]
  ): Promise<void> {
    for (const entry of entries) {
      if (entry.type !== "message") continue;
      const key = execution.messageKeys.get(messageFingerprint(entry.message));
      if (!key) continue;
      await this.emitRuntimeEvent(active, execution, {
        type: "message_entry_resolved",
        messageKey: key,
        entryId: entry.id
      });
    }
  }

  private async rebuildProjection(
    active: ActiveConversation,
    runState: PiChatUiViewModel["runState"]
  ): Promise<PiChatUiViewModel> {
    const diagnostics = await this.catalog.diagnostics(
      active.catalog.conversationId
    );
    const runs = await this.productRuns.list(
      active.catalog.conversationId
    );
    const productRunId = active.currentRun?.productRunId
      ?? runs.at(-1)?.productRunId;
    const toolProductState = await this.loadToolProductState(active.catalog);
    const branchEntries = active.sessionManager.getBranch();
    const projected = this.projector.projectSessionBranch({
      piSessionId: active.catalog.piSessionId,
      activeLeafId: active.sessionManager.getLeafId(),
      entries: branchEntries,
      diagnostics,
      runState,
      productRunId,
      runIdentities: runs.map(runIdentity),
      ...toolProductState,
      now: this.now()
    });
    settleFailedKnowledgeMaintenanceToolCalls(projected, runs, branchEntries);
    const decorated = this.projector.decorate(
      projected,
      await this.loadKnowledgeDecorations(active.catalog, branchEntries)
    );
    preserveLiveAssistantTurnProjection(decorated, active.projection);
    return hideInternalSkillPromptPrefixes(decorated);
  }

  private async projectionFromActive(
    active: ActiveConversation
  ): Promise<PiConversationProjection> {
    projectInjectedMemorySources(active.projection.messages, active.sessionManager.getBranch(), active.catalog.piSessionId);
    active.projection.messages = projectGenerationEntries(active.projection.messages, active.sessionManager.getBranch());
    active.projection = this.projector.decorateToolProductState(
      active.projection,
      await this.loadToolProductState(active.catalog)
    );
    active.projection = this.projector.decorate(
      active.projection,
      await this.loadKnowledgeDecorations(
        active.catalog,
        active.sessionManager.getBranch()
      )
    );
    const contextLedger = latestPiContextLedger(
      active.sessionManager.getBranch()
    );
    return {
      catalog: active.catalog,
      activeLeafId: active.projection.activeLeafId,
      messages: active.projection.messages.map((message) => ({
        ...message,
        ...(message.approval ? { approval: { ...message.approval } } : {})
      })),
      diagnostics: await this.catalog.diagnostics(
        active.catalog.conversationId
      ),
      drafts: await this.catalog.drafts(active.catalog.conversationId),
      ...(contextLedger ? { contextLedger } : {})
    };
  }

  private async loadToolProductState(
    catalog: Readonly<PiConversationCatalogEntry>,
    productRunId?: string
  ): Promise<Readonly<PiChatUiToolProductProjectionInput>> {
    return await this.options.loadToolProductState?.({
      conversationId: catalog.conversationId,
      piSessionId: catalog.piSessionId,
      ...(productRunId ? { productRunId } : {})
    }) ?? Object.freeze({});
  }

  private async loadKnowledgeDecorations(
    catalog: Readonly<PiConversationCatalogEntry>,
    entries: readonly SessionEntry[]
  ): Promise<readonly PiChatUiMessageDecoration[]> {
    return await this.options.loadKnowledgeDecorations?.({
      conversationId: catalog.conversationId,
      piSessionId: catalog.piSessionId,
      entries
    }) ?? Object.freeze([]);
  }

  private async openCatalogSession(
    catalog: Readonly<PiConversationCatalogEntry>
  ) {
    return await openDurableConversationSession({
      catalogStore: this.catalog,
      catalog,
      sessionApi: this.options.sessionApi,
      resolveConversationCwd: (conversationId) =>
        this.options.resolveConversationCwd(conversationId),
      now: this.now
    });
  }

  private async replaceAgentSessionWarnings(
    catalog: Readonly<PiConversationCatalogEntry>,
    warnings: readonly string[]
  ): Promise<void> {
    const existing = await this.catalog.diagnostics(catalog.conversationId);
    const previousWarnings = new Map(existing
      .filter((diagnostic) => diagnostic.code === "runtime_resource_warning")
      .map((diagnostic) => [diagnostic.diagnosticId, diagnostic] as const));
    const normalizedWarnings = Array.from(new Set(warnings
      .map(normalizeAgentSessionWarning)
      .filter((warning): warning is string => Boolean(warning))));
    const createdAt = this.now();
    const currentWarnings = normalizedWarnings.map((message) => {
      const diagnosticId = stableId(
        "diagnostic",
        catalog.conversationId,
        catalog.piSessionId,
        "runtime_resource_warning",
        message
      );
      return {
        diagnosticId,
        conversationId: catalog.conversationId,
        piSessionId: catalog.piSessionId,
        code: "runtime_resource_warning" as const,
        message,
        createdAt: previousWarnings.get(diagnosticId)?.createdAt ?? createdAt
      };
    });
    const unchanged = previousWarnings.size === currentWarnings.length
      && currentWarnings.every((diagnostic) => {
        const previous = previousWarnings.get(diagnostic.diagnosticId);
        return previous?.message === diagnostic.message
          && previous.createdAt === diagnostic.createdAt;
      });
    if (unchanged) return;
    await this.catalog.diagnostics(catalog.conversationId, [
      ...existing.filter((diagnostic) =>
        diagnostic.code !== "runtime_resource_warning"
      ),
      ...currentWarnings
    ]);
  }

  private async persistQueueDrafts(
    active: ActiveConversation,
    execution: ActiveProductRun,
    steering: readonly string[],
    followUp: readonly string[]
  ): Promise<void> {
    const existing = await this.catalog.drafts(
      active.catalog.conversationId
    );
    const preserved = existing.filter(
      (draft) => draft.source === "abort" || draft.source === "restart"
    );
    const createdAt = this.now();
    const queued = [
      ...steering.map((text, index) => ({ source: "steering" as const, text, index })),
      ...followUp.map((text, index) => ({ source: "follow_up" as const, text, index }))
    ].map((draft) => ({
      draftId: stableId(
        "draft",
        execution.productRunId,
        draft.source,
        String(draft.index),
        draft.text
      ),
      conversationId: active.catalog.conversationId,
      piSessionId: active.catalog.piSessionId,
      source: draft.source,
      text: draft.text,
      createdAt
    }));
    await this.catalog.drafts(active.catalog.conversationId, [
      ...preserved,
      ...queued
    ]);
  }

  private async persistAbortDrafts(
    active: ActiveConversation,
    execution: ActiveProductRun,
    cleared: { steering: string[]; followUp: string[] }
  ): Promise<void> {
    const existing = await this.catalog.drafts(
      active.catalog.conversationId
    );
    const preserved = existing.filter(
      (draft) => draft.source === "abort" || draft.source === "restart"
    );
    const texts = [...cleared.steering, ...cleared.followUp];
    const createdAt = this.now();
    await this.catalog.drafts(active.catalog.conversationId, [
      ...preserved,
      ...texts.map((text, index) => ({
        draftId: stableId(
          "draft-abort",
          execution.productRunId,
          String(index),
          text
        ),
        conversationId: active.catalog.conversationId,
        piSessionId: active.catalog.piSessionId,
        source: "abort" as const,
        text,
        createdAt
      }))
    ]);
  }

  private async restoreQueuedDraftsAsRestart(
    conversationId: string
  ) {
    const drafts = await this.catalog.drafts(conversationId);
    if (!drafts.some(
      (draft) => draft.source === "steering" || draft.source === "follow_up"
    )) {
      return drafts;
    }
    const converted = drafts.map((draft) =>
      draft.source === "steering" || draft.source === "follow_up"
        ? { ...draft, source: "restart" as const }
        : draft
    );
    return await this.catalog.drafts(conversationId, converted);
  }

  private requireRunningConversation(
    conversationId: string
  ): ActiveConversation {
    const active = this.active.get(conversationId);
    if (!active?.currentRun || !active.session.isStreaming) {
      throw new PiNativeConversationRuntimeError(
        "conversation_busy",
        `Conversation ${conversationId} 当前没有可接收队列消息的 ProductRun`
      );
    }
    return active;
  }

  private async requireCatalogConversation(
    conversationId: string
  ): Promise<Readonly<PiConversationCatalogEntry>> {
    const catalog = await this.catalog.get(conversationId);
    if (!catalog) {
      throw new PiNativeConversationRuntimeError(
        "conversation_not_found",
        `Conversation ${conversationId} 不存在`
      );
    }
    return catalog;
  }

  private assertReady(): void {
    if (!this.initialized) {
      throw new PiNativeConversationRuntimeError(
        "runtime_not_initialized",
        "Pi-native Conversation Runtime 尚未初始化"
      );
    }
    if (this.shuttingDown) {
      throw new PiNativeConversationRuntimeError(
        "runtime_shutting_down",
        "Pi-native Conversation Runtime 正在关闭"
      );
    }
  }

  private assertConversationNotRecovering(conversationId: string): void {
    if (!this.recoveringConversations.has(conversationId)) return;
    throw new PiNativeConversationRuntimeError(
      "conversation_busy",
      `Conversation ${conversationId} 正在恢复 Pi Session`
    );
  }

  private nextId(kind: string): string {
    const id = this.idFactory();
    if (!safeIdentifier(id)) {
      throw new Error(`${kind} identity is invalid`);
    }
    return id;
  }
}

export function buildDreamPublicExperienceFromRun(input: Readonly<{
  conversationId: string;
  productRunId: string;
  userEntryId: string;
  assistantEntryId: string;
  terminalState: "completed" | "failed";
  occurredAt: number;
  entries: readonly SessionEntry[];
}>): DreamPublicExperienceInput | null {
  const userEntry = input.entries.find((entry) => entry.id === input.userEntryId);
  const assistantEntry = input.entries.find((entry) => entry.id === input.assistantEntryId);
  if (!userEntry || userEntry.type !== "message" || userEntry.message.role !== "user"
    || !assistantEntry || assistantEntry.type !== "message"
    || assistantEntry.message.role !== "assistant") return null;
  const userText = publicMessageText(userEntry.message).trim();
  const assistantText = publicMessageText(assistantEntry.message).trim();
  if (!userText && !assistantText) return null;
  return Object.freeze({
    conversationId: input.conversationId,
    productRunId: input.productRunId,
    userEntryId: input.userEntryId,
    assistantEntryId: input.assistantEntryId,
    occurredAt: input.occurredAt,
    userText,
    assistantText,
    taskResult: collectMinimalDreamTaskResult(input.entries, input.terminalState)
  });
}

function collectMinimalDreamTaskResult(
  entries: readonly SessionEntry[],
  terminalState: "completed" | "failed"
): DreamTaskResultSummary {
  const successful = new Set<string>();
  const failed = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
    const name = entry.message.toolName.trim();
    if (!name) continue;
    (entry.message.isError ? failed : successful).add(name);
  }
  return Object.freeze({
    terminalState,
    successfulToolNames: Object.freeze([...successful].sort()),
    failedToolNames: Object.freeze([...failed].sort())
  });
}

/** Append to one inactive conversation without constructing a Provider runtime. */
export async function recordDurablePiAnswerSave(input: {
  catalog: FileConversationCatalog;
  sessionApi: PiSessionManagerApi;
  conversationId: string;
  messageId: string;
  path: string;
  resolveConversationCwd(this: void, conversationId: string): Promise<string> | string;
  now?: () => number;
}): Promise<void> {
  const catalog = await input.catalog.get(input.conversationId);
  if (!catalog || catalog.status === "deleted") throw new Error("原对话已不存在，无法保存关联状态。");
  const opened = await openDurableConversationSession({
    catalogStore: input.catalog, catalog, sessionApi: input.sessionApi,
    resolveConversationCwd: input.resolveConversationCwd, now: input.now ?? Date.now
  });
  appendSavedAnswerNote({
    sessionRoot: input.catalog.sessionRootPath, sessionManager: opened.sessionManager,
    piSessionId: catalog.piSessionId,
    assistantEntryId: piEntryIdFromProjectedMessageId(input.messageId) ?? "", path: input.path
  });
}

/**
 * Rebuild the durable UI projection without constructing AgentSession or any
 * Provider/model runtime. Both the local-data service and the production
 * runtime use this exact reader so history has one storage and projection
 * authority even while full runtime initialization is still pending.
 */
export async function readDurablePiConversationProjection(
  options: ReadDurablePiConversationProjectionOptions
): Promise<PiConversationProjection> {
  const catalog = await options.catalog.get(options.conversationId);
  if (!catalog) {
    throw new PiNativeConversationRuntimeError(
      "conversation_not_found",
      `Conversation ${options.conversationId} 不存在`
    );
  }
  const now = options.now ?? Date.now;
  const projector = options.projector ?? new PiChatUiProjector();
  const opened = await openDurableConversationSession({
    catalogStore: options.catalog,
    catalog,
    sessionApi: options.sessionApi,
    resolveConversationCwd: (conversationId) =>
      options.resolveConversationCwd(conversationId),
    now
  });
  const runs = await options.productRuns.list(options.conversationId);
  const last = runs.at(-1);
  const diagnostics = await options.catalog.diagnostics(options.conversationId);
  const drafts = await options.catalog.drafts(options.conversationId);
  const toolProductState = await options.loadToolProductState?.({
    conversationId: catalog.conversationId,
    piSessionId: catalog.piSessionId
  }) ?? Object.freeze({});
  const branchEntries = opened.sessionManager.getBranch();
  const projected = projector.projectSessionBranch({
    piSessionId: catalog.piSessionId,
    activeLeafId: opened.sessionManager.getLeafId(),
    entries: branchEntries,
    diagnostics,
    runState: last && last.state !== "product_run_settled"
      ? "interrupted"
      : terminalRunState(last),
    productRunId: last?.productRunId,
    runIdentities: runs.map(runIdentity),
    queuedSteering: [],
    queuedFollowUp: [],
    ...toolProductState,
    now: now()
  });
  settleFailedKnowledgeMaintenanceToolCalls(projected, runs, branchEntries);
  const view = hideInternalSkillPromptPrefixes(projector.decorate(
    projected,
    await options.loadKnowledgeDecorations?.({
      conversationId: catalog.conversationId,
      piSessionId: catalog.piSessionId,
      entries: branchEntries
    }) ?? Object.freeze([])
  ));
  const contextLedger = latestPiContextLedger(branchEntries);
  return {
    catalog,
    activeLeafId: view.activeLeafId,
    messages: view.messages,
    diagnostics,
    drafts,
    ...(contextLedger ? { contextLedger } : {})
  };
}

async function openDurableConversationSession(input: Readonly<{
  catalogStore: FileConversationCatalog;
  catalog: Readonly<PiConversationCatalogEntry>;
  sessionApi: PiSessionManagerApi;
  resolveConversationCwd(
    conversationId: string
  ): Promise<string> | string;
  now: () => number;
}>) {
  if (!input.catalog.sessionFile) {
    throw new PiNativeConversationRuntimeError(
      "agent_session_invalid",
      `Conversation ${input.catalog.conversationId} 没有 Pi Session 文件`
    );
  }
  const cwd = await input.resolveConversationCwd(
    input.catalog.conversationId
  );
  try {
    return openDurablePiSession({
      api: input.sessionApi,
      sessionRoot: input.catalogStore.sessionRootPath,
      sessionFile: input.catalog.sessionFile,
      cwd,
      createRecoveryOnCorruption: true
    });
  } catch (error) {
    if (error instanceof PiSessionDurabilityError) {
      await persistPiSessionDurabilityDiagnostics({
        catalogStore: input.catalogStore,
        catalog: input.catalog,
        error,
        now: input.now
      });
    }
    throw error;
  }
}

async function persistPiSessionDurabilityDiagnostics(input: Readonly<{
  catalogStore: FileConversationCatalog;
  catalog: Readonly<PiConversationCatalogEntry>;
  error: PiSessionDurabilityError;
  now: () => number;
}>): Promise<void> {
  const persistedById = new Map(
    (await input.catalogStore.diagnostics(input.catalog.conversationId)).map(
      (diagnostic) => [diagnostic.diagnosticId, diagnostic] as const
    )
  );
  for (const diagnostic of input.error.diagnostics) {
    const diagnosticId = stableId(
      "diagnostic",
      input.catalog.conversationId,
      diagnostic.code,
      diagnostic.sourcePath,
      String(diagnostic.lineNumber ?? 0),
      String(diagnostic.byteOffset ?? 0),
      diagnostic.recoveryPath ?? ""
    );
    const persisted = persistedById.get(diagnosticId);
    if (
      persisted
      && persisted.conversationId === input.catalog.conversationId
      && persisted.piSessionId === input.catalog.piSessionId
      && persisted.code === diagnostic.code
      && persisted.message === diagnostic.message
      && persisted.sourcePath === diagnostic.sourcePath
      && persisted.recoveryPath === diagnostic.recoveryPath
    ) {
      continue;
    }
    const productDiagnostic: PiConversationDiagnostic = {
      diagnosticId,
      conversationId: input.catalog.conversationId,
      piSessionId: input.catalog.piSessionId,
      code: diagnostic.code,
      message: diagnostic.message,
      sourcePath: diagnostic.sourcePath,
      recoveryPath: diagnostic.recoveryPath,
      createdAt: persisted?.createdAt ?? input.now()
    };
    const appended = await input.catalogStore.appendDiagnostic(productDiagnostic);
    persistedById.set(appended.diagnosticId, appended);
  }
}

function validateCreatedAgentSession(
  session: AgentSession,
  catalog: Readonly<PiConversationCatalogEntry>,
  sessionManager: SessionManager
): void {
  if (
    !session
    || session.sessionManager !== sessionManager
    || session.sessionId !== catalog.piSessionId
    || session.sessionFile !== catalog.sessionFile
    || session.getActiveToolNames().some((name) => BUILTIN_TOOL_NAMES.has(name))
  ) {
    session?.dispose?.();
    throw new PiNativeConversationRuntimeError(
      "agent_session_invalid",
      "Coding AgentSession did not preserve the Catalog/Session binding or exposed a forbidden builtin Tool"
    );
  }
}

function validatePlanToolNames(
  session: AgentSession,
  names: readonly string[]
): void {
  const registered = new Set(session.getAllTools().map((tool) => tool.name));
  const unique = new Set(names);
  if (
    unique.size !== names.length
    || names.some((name) =>
      !safeIdentifier(name)
      || BUILTIN_TOOL_NAMES.has(name)
      || !registered.has(name)
    )
  ) {
    session.dispose?.();
    throw new PiNativeConversationRuntimeError(
      "agent_session_invalid",
      "Pi Task/Plan read-only Tool allowlist is invalid"
    );
  }
}

async function waitForNewUserEntry(
  sessionManager: SessionManager,
  baselineEntryIds: ReadonlySet<string>,
  timeoutMs: number,
  promptStart: { readyAt: number | undefined; settled: boolean; error: unknown }
): Promise<SessionEntry> {
  while (true) {
    const candidate = sessionManager.getEntries().find((entry) =>
      !baselineEntryIds.has(entry.id)
      && entry.type === "message"
      && entry.message.role === "user"
    );
    if (candidate) return candidate;
    if (promptStart.settled && promptStart.error) {
      throw promptStart.error instanceof Error
        ? promptStart.error
        : new Error(safeRuntimeErrorText(promptStart.error), { cause: promptStart.error });
    }
    // Always read first: a background timer can resume after the deadline
    // even though Pi has already appended the Entry.
    if (promptStart.settled || (promptStart.readyAt !== undefined && Date.now() - promptStart.readyAt >= timeoutMs)) break;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  }
  throw new PiNativeConversationRuntimeError(
    "agent_session_invalid",
    "The first user Entry was not appended before the assistant request"
  );
}

function currentRunUserEntry(
  sessionManager: SessionManager,
  baselineEntryIds: ReadonlySet<string>
): Extract<SessionEntry, { type: "message" }> {
  const candidate = sessionManager.getEntries().find((entry) =>
    !baselineEntryIds.has(entry.id)
    && entry.type === "message"
    && entry.message.role === "user"
  );
  if (!candidate || candidate.type !== "message") {
    throw new PiNativeConversationRuntimeError(
      "provider_execution_unbound",
      "Memory Tool execution has no current durable Pi user Entry"
    );
  }
  return candidate;
}

function messageKey(
  execution: ActiveProductRun,
  message: AgentMessage
): string {
  const fingerprint = messageFingerprint(message);
  const existing = execution.messageKeys.get(fingerprint);
  if (existing) return existing;
  execution.messageSequence += 1;
  const key = `message-${execution.messageSequence}`;
  execution.messageKeys.set(fingerprint, key);
  return key;
}

function messageFingerprint(message: AgentMessage): string {
  const record = message as unknown as Record<string, unknown>;
  return [
    fingerprintPart(record.role, "unknown"),
    fingerprintPart(record.timestamp),
    fingerprintPart(record.toolCallId),
    fingerprintPart(record.customType)
  ].join("\0");
}

function fingerprintPart(value: unknown, fallback = ""): string {
  return typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
    || typeof value === "bigint"
    ? String(value)
    : fallback;
}

function runtimeMessageRole(
  message: AgentMessage
): "user" | "assistant" | "tool" {
  if (message.role === "user") return "user";
  if (message.role === "assistant") return "assistant";
  return "tool";
}

function runtimeMessageStatus(
  message: AgentMessage
): "completed" | "failed" | "cancelled" {
  if (isAssistantMessage(message)) {
    if (message.stopReason === "aborted") return "cancelled";
    if (message.stopReason === "error") return "failed";
  }
  if (message.role === "toolResult" && message.isError) return "failed";
  return "completed";
}

function providerReasoningStatusForMessage(
  message: AgentMessage
): Extract<
  PiChatRuntimeEvent,
  { type: "provider_reasoning_end" }
>["status"] {
  if (!isAssistantMessage(message)) return "interrupted";
  return runtimeMessageStatus(message);
}

function providerReasoningStatusForTerminalState(
  state: PiProductRunTerminalState
): Extract<
  PiChatRuntimeEvent,
  { type: "provider_reasoning_end" }
>["status"] {
  if (state === "completed") return "completed";
  return state === "cancelled" ? "cancelled" : "failed";
}

function providerReasoningBlockKey(
  messageKeyValue: string,
  contentIndex: number
): string {
  return `${messageKeyValue}\0${contentIndex}`;
}

function providerReasoningSegmentId(
  productRunId: string,
  messageKeyValue: string,
  contentIndex: number
): string {
  return stableId(
    "provider-reasoning",
    `${productRunId}\0${messageKeyValue}\0${contentIndex}`
  );
}

function providerReasoningMessageTimestamp(
  message: Pick<AssistantMessage, "timestamp">,
  observedAt: number
): Readonly<{ messageTimestamp?: number }> {
  const timestamp = message.timestamp;
  return typeof timestamp === "number"
    && Number.isFinite(timestamp)
    && timestamp >= 0
    && timestamp <= observedAt
    ? { messageTimestamp: timestamp }
    : {};
}

function beginPublicProviderReasoning(
  execution: ActiveProductRun,
  block: MutableProviderReasoningBlock
): void {
  if (execution.providerReasoningExposedMessageKeys.has(block.messageKey)) return;
  execution.providerReasoningExposedMessageKeys.add(block.messageKey);
  if (block.messageTimestamp !== undefined) {
    block.startedAt = block.messageTimestamp;
  }
}

function providerThinkingContentAt(
  message: Pick<AssistantMessage, "content">,
  contentIndex: number
): ThinkingContent | null {
  if (!Number.isSafeInteger(contentIndex) || contentIndex < 0) return null;
  const content = message.content[contentIndex];
  if (
    !content
    || content.type !== "thinking"
    || typeof content.thinking !== "string"
  ) return null;
  return content;
}

function preserveLiveAssistantTurnProjection(
  target: PiChatUiViewModel,
  current: Readonly<PiChatUiViewModel>
): void {
  const latestByTurn = new Map<
    string,
    Readonly<EchoInkAssistantTurnSnapshot>
  >();
  for (const message of current.messages) {
    const turn = message.assistantTurn;
    if (!turn) continue;
    const existing = latestByTurn.get(turn.turnId);
    if (!existing || existing.updatedAt <= turn.updatedAt) {
      latestByTurn.set(turn.turnId, turn);
    }
  }
  for (const [turnId, turn] of latestByTurn) {
    const carrier = target.messages.find((message) =>
      message.reasoningSummary?.productRunId === turnId
    ) ?? target.messages.find((message) => message.runId === turnId);
    if (!carrier) continue;
    if (
      carrier.assistantTurn
      && carrier.assistantTurn.updatedAt > turn.updatedAt
    ) continue;
    carrier.assistantTurn = cloneEchoInkAssistantTurn(turn);
  }
}

function assertPiChatSubmitModelIdentity(
  session: Pick<AgentSession, "model">,
  request: Readonly<PiChatSubmitRequest>
): void {
  const runtimeProviderId = typeof request.runtimeProviderId === "string"
    ? request.runtimeProviderId.trim()
    : "";
  const modelId = typeof request.modelId === "string"
    ? request.modelId.trim()
    : "";
  const model = session.model;
  if (
    !runtimeProviderId
    || runtimeProviderId !== request.runtimeProviderId
    || !modelId
    || modelId !== request.modelId
    || !model
    || model.provider !== runtimeProviderId
    || model.id !== modelId
  ) {
    throw new PiNativeConversationRuntimeError(
      "provider_execution_unbound",
      "本轮冻结的 Provider/模型与当前 Pi Session 不一致，已在 Provider 请求前停止。"
    );
  }
}

function validatedPiThinkingLevel(
  model: Model<Api> | undefined,
  reasoning: unknown
): ModelThinkingLevel {
  if (!model) {
    throw new PiNativeConversationRuntimeError(
      "reasoning_level_invalid",
      "当前 Pi Session 没有可验证的模型，本轮未调用 Provider。"
    );
  }
  if (!isEchoInkReasoningEffort(reasoning)) {
    throw new PiNativeConversationRuntimeError(
      "reasoning_level_invalid",
      "本轮没有合法的冻结思考强度，已在 Provider 请求前停止。"
    );
  }
  const capabilities = resolveEchoInkPiModelReasoningCapabilities(model);
  if (!isEchoInkPiReasoningEffortSupported(capabilities, reasoning)) {
    throw new PiNativeConversationRuntimeError(
      "reasoning_level_invalid",
      `思考强度 ${reasoning} 不受当前 Pi 模型支持，本轮未调用 Provider。`
    );
  }
  const requested = reasoning === "none" ? "off" : reasoning;
  const clamped = clampThinkingLevel(model, requested);
  if (clamped !== requested) {
    throw new PiNativeConversationRuntimeError(
      "reasoning_level_invalid",
      `思考强度 ${reasoning} 会被 Pi 改为 ${clamped}，本轮已在 Provider 请求前停止。`
    );
  }
  return requested;
}

function localAssistantMessage(
  session: AgentSession,
  text: string,
  timestamp: number
): AssistantMessage {
  const model = session.model;
  const modelApi: unknown = model?.api;
  const modelProvider: unknown = model?.provider;
  const modelId: unknown = model?.id;
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: typeof modelApi === "string" ? modelApi : "echoink-local",
    provider: typeof modelProvider === "string"
      ? modelProvider
      : "echoink-local",
    model: typeof modelId === "string" ? modelId : "local-fixed-response",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0
      }
    },
    stopReason: "stop",
    timestamp
  };
}

function publicMessageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
        .filter((part): part is { type: "text"; text: string } =>
          typeof part === "object"
          && part !== null
          && (part as { type?: unknown }).type === "text"
          && typeof (part as { text?: unknown }).text === "string"
        )
        .map((part) => part.text)
        .join("")
      : "";
  return message.role === "user" ? stripInternalSkillPromptPrefix(text) : text;
}

function hideInternalSkillPromptPrefixes(
  projection: PiChatUiViewModel
): PiChatUiViewModel {
  projection.messages = projection.messages.map((message) => {
    if (message.role !== "user") return message;
    const text = stripInternalSkillPromptPrefix(message.text);
    return text === message.text ? message : { ...message, text };
  });
  return projection;
}

function stripInternalSkillPromptPrefix(text: string): string {
  let remaining = text;
  let stripped = false;
  while (remaining.startsWith("<skill name=\"")) {
    const block = remaining.match(
      /^<skill name="[^"\r\n]+"(?: location="[^"\r\n]+")?>[\s\S]*?<\/skill>\r?\n\r?\n/u
    );
    if (!block) break;
    remaining = remaining.slice(block[0].length);
    stripped = true;
  }
  return stripped ? remaining : text;
}

function classifyTerminalState(
  entries: readonly SessionEntry[],
  abortRequested: boolean,
  promptError: unknown
): PiProductRunTerminalState {
  const assistant = lastAssistantEntry(entries)?.message;
  if (abortRequested || assistant?.stopReason === "aborted") {
    return "cancelled";
  }
  if (
    promptError
    || !assistant
    || assistant.stopReason === "error"
    || assistant.stopReason === "length"
  ) {
    return "failed";
  }
  return "completed";
}

function lastAssistantEntry(
  entries: readonly SessionEntry[]
): (Extract<SessionEntry, { type: "message" }> & {
  message: AssistantMessage;
}) | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === "message" && isAssistantMessage(entry.message)) {
      return entry as Extract<SessionEntry, { type: "message" }> & {
        message: AssistantMessage;
      };
    }
  }
  return undefined;
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return typeof message === "object"
    && message !== null
    && (message as { role?: unknown }).role === "assistant"
    && typeof (message as { stopReason?: unknown }).stopReason === "string";
}

function editorTextFromUserMessage(message: AgentMessage): string {
  if (message.role !== "user") return "";
  const text = typeof message.content === "string"
    ? message.content
    : message.content
      .filter((part): part is Extract<typeof part, { type: "text" }> =>
        part.type === "text" && typeof part.text === "string"
      )
      .map((part) => part.text)
      .join("\n");
  return stripInternalSkillPromptPrefix(text);
}

function lastAssistantEntryId(entries: readonly SessionEntry[]): string | undefined {
  return lastAssistantEntry(entries)?.id;
}

function collectToolCallIds(
  entries: readonly SessionEntry[],
  observed: ReadonlySet<string>
): string[] {
  const ids = new Set(observed);
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    if (entry.message.role === "assistant") {
      for (const part of entry.message.content) {
        if (part.type === "toolCall") ids.add(part.id);
      }
    } else if (entry.message.role === "toolResult") {
      ids.add(entry.message.toolCallId);
    }
  }
  return [...ids].sort();
}

function collectSuccessfulNoteReadPaths(
  entries: readonly SessionEntry[]
): string[] {
  const pathsByToolCallId = new Map<string, string>();
  const pathsFromResults = new Set<string>();
  const successfulToolCallIds = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    if (entry.message.role === "assistant") {
      for (const part of entry.message.content) {
        if (
          part.type !== "toolCall"
          || part.name !== "note_read"
          || typeof part.arguments?.relativePath !== "string"
        ) continue;
        const relativePath = part.arguments.relativePath.trim();
        if (relativePath) pathsByToolCallId.set(part.id, relativePath);
      }
    } else if (
      entry.message.role === "toolResult"
      && entry.message.toolName === "note_read"
      && !entry.message.isError
    ) {
      successfulToolCallIds.add(entry.message.toolCallId);
      const details: unknown = entry.message.details;
      if (
        details
        && typeof details === "object"
        && !Array.isArray(details)
        && (details as Record<string, unknown>).type
          === KNOWLEDGE_REFERENCE_ENTRY_DETAILS_TYPE
        && (details as Record<string, unknown>).schemaVersion === 1
        && Array.isArray((details as Record<string, unknown>).references)
      ) {
        for (const reference of (details as Record<string, unknown>).references as unknown[]) {
          if (
            reference
            && typeof reference === "object"
            && !Array.isArray(reference)
            && typeof (reference as Record<string, unknown>).vaultRelativePath
              === "string"
          ) {
            const relativePath = (
              (reference as Record<string, unknown>).vaultRelativePath as string
            ).trim();
            if (relativePath) pathsFromResults.add(relativePath);
          }
        }
      }
    }
  }
  return Array.from(new Set(
    [
      ...pathsFromResults,
      ...[...successfulToolCallIds]
        .map((toolCallId) => pathsByToolCallId.get(toolCallId))
        .filter((value): value is string => Boolean(value))
    ]
  )).sort();
}

function collectKnowledgeToolReferences(
  entries: readonly SessionEntry[]
): PiKnowledgeReference[] {
  const references = new Map<string, PiKnowledgeReference>();
  for (const entry of entries) {
    if (
      entry.type !== "message"
      || entry.message.role !== "toolResult"
      || (
        entry.message.toolName !== "knowledge_read"
        && entry.message.toolName !== "note_read"
      )
      || entry.message.isError
      || !entry.message.details
      || typeof entry.message.details !== "object"
      || Array.isArray(entry.message.details)
    ) continue;
    const details = entry.message.details as Record<string, unknown>;
    if (
      details.type !== KNOWLEDGE_REFERENCE_ENTRY_DETAILS_TYPE
      || details.schemaVersion !== 1
      || !Array.isArray(details.references)
    ) continue;
    for (const value of details.references) {
      const reference = parseKnowledgeReference(value);
      if (reference) references.set(reference.referenceId, reference);
    }
  }
  return [...references.values()];
}

function parseKnowledgeReference(value: unknown): PiKnowledgeReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const reference = value as Record<string, unknown>;
  if (
    typeof reference.referenceId !== "string"
    || !reference.referenceId.trim()
    || typeof reference.vaultRelativePath !== "string"
    || !reference.vaultRelativePath.trim()
    || typeof reference.title !== "string"
    || typeof reference.excerpt !== "string"
    || typeof reference.contentRevision !== "string"
    || !/^sha256:[a-f0-9]{64}$/u.test(reference.contentRevision)
    || !Number.isSafeInteger(reference.lineStart)
    || !Number.isSafeInteger(reference.lineEnd)
    || (reference.lineStart as number) < 1
    || (reference.lineEnd as number) < (reference.lineStart as number)
  ) return null;
  return Object.freeze({
    ...(Number.isSafeInteger(reference.columnStart) && Number.isSafeInteger(reference.columnEnd) ? { columnStart: reference.columnStart as number, columnEnd: reference.columnEnd as number } : {}),
    referenceId: reference.referenceId,
    vaultRelativePath: reference.vaultRelativePath,
    title: reference.title,
    excerpt: reference.excerpt,
    contentRevision: reference.contentRevision,
    lineStart: reference.lineStart as number,
    lineEnd: reference.lineEnd as number,
    ...(typeof reference.sectionTitle === "string" ? { sectionTitle: reference.sectionTitle } : {}),
    ...(KNOWLEDGE_SEARCH_KINDS.includes(reference.sourceType as KnowledgeSearchKind) ? { sourceType: reference.sourceType as KnowledgeSearchKind } : {}),
    ...(typeof reference.recordedAt === "number" && Number.isFinite(reference.recordedAt) ? { recordedAt: reference.recordedAt } : {}),
    ...(typeof reference.publishedAt === "string" ? { publishedAt: reference.publishedAt } : {}),
    ...(typeof reference.totalLines === "number" ? { totalLines: reference.totalLines } : {}),
    ...(typeof reference.hasMore === "boolean" ? { hasMore: reference.hasMore } : {}),
    ...(reference.verificationStatus === "local_revision_verified" || reference.verificationStatus === "source_link_changed" ? { verificationStatus: reference.verificationStatus } : {})
  });
}

function freezePersonalMemorySourceReferences(
  sources: readonly Readonly<PersonalMemorySourceReference>[]
): readonly Readonly<PersonalMemorySourceReference>[] {
  const unique = new Map<string, Readonly<PersonalMemorySourceReference>>();
  for (const source of sources) {
    const id = source.id.trim();
    const title = source.title.trim();
    if (!id || !title || unique.has(id)) continue;
    unique.set(id, Object.freeze({ id, title }));
  }
  return Object.freeze([...unique.values()]);
}

function mergePersonalMemorySourceReferences(
  ...groups: readonly (readonly Readonly<PersonalMemorySourceReference>[])[]
): readonly Readonly<PersonalMemorySourceReference>[] {
  return freezePersonalMemorySourceReferences(groups.flat());
}

/**
 * Collects display-only primary Memory metadata from successful read Tool
 * Results already committed to this `/ask` run's Pi Branch. The Branch check
 * deliberately excludes candidates, failed calls, cancelled turns, and raw
 * repository values that never reached the model context.
 */
export function collectSuccessfulAskPersonalMemoryToolSources(
  entries: readonly SessionEntry[]
): readonly Readonly<PersonalMemorySourceReference>[] {
  const sources: PersonalMemorySourceReference[] = [];
  for (const entry of entries) {
    if (
      entry.type !== "message"
      || entry.message.role !== "toolResult"
      || entry.message.isError
      || (
        entry.message.toolName !== "memory_search"
        && entry.message.toolName !== "memory_read"
      )
    ) continue;
    const recordIds = completedPersonalMemoryToolRecordIds(
      entry.message.details,
      entry.message.toolName
    );
    if (recordIds.length === 0) continue;
    sources.push(...personalMemorySourcesFromToolResult(
      entry.message.toolName,
      entry.message.content,
      recordIds
    ));
  }
  return freezePersonalMemorySourceReferences(sources);
}

function completedPersonalMemoryToolRecordIds(
  value: unknown,
  toolName: "memory_search" | "memory_read"
): readonly string[] {
  const details = safeRecord(value);
  if (
    details?.source !== "echoink-personal-memory"
    || details.schemaVersion !== 1
    || details.toolId !== toolName
    || details.status !== "completed"
    || !Array.isArray(details.recordIds)
  ) return [];
  const ids = new Set<string>();
  for (const value of details.recordIds) {
    if (typeof value !== "string" || !value.trim()) continue;
    ids.add(value.trim());
  }
  return [...ids];
}

function personalMemorySourcesFromToolResult(
  toolName: "memory_search" | "memory_read",
  content: unknown,
  recordIds: readonly string[]
): PersonalMemorySourceReference[] {
  const payload = personalMemoryToolResultPayload(toolName, content);
  if (!payload) return [];
  const candidates = toolName === "memory_search"
    ? Array.isArray(payload.items) ? payload.items : []
    : [payload.record];
  const allowedIds = new Set(recordIds);
  const sources: PersonalMemorySourceReference[] = [];
  for (const candidate of candidates) {
    const record = safeRecord(candidate);
    const id = typeof record?.id === "string" ? record.id.trim() : "";
    const title = typeof record?.title === "string" ? record.title.trim() : "";
    if (!id || !title || !allowedIds.has(id)) continue;
    sources.push({ id, title });
  }
  return sources;
}

function personalMemoryToolResultPayload(
  toolName: "memory_search" | "memory_read",
  content: unknown
): Readonly<Record<string, unknown>> | null {
  if (!Array.isArray(content)) return null;
  const text = content
    .flatMap((part) => {
      const value = safeRecord(part);
      return value?.type === "text" && typeof value.text === "string"
        ? [value.text]
        : [];
    })
    .join("");
  const prefix = `<echoink_memory_result tool="${toolName}" trust="untrusted-background">\n`;
  const suffix = "\n</echoink_memory_result>";
  if (!text.startsWith(prefix) || !text.endsWith(suffix)) return null;
  try {
    return safeRecord(JSON.parse(text.slice(prefix.length, -suffix.length)));
  } catch {
    return null;
  }
}

function mergeKnowledgeReferences(
  ...groups: readonly (readonly Readonly<PiKnowledgeReference>[])[]
): PiKnowledgeReference[] {
  const references = new Map<string, PiKnowledgeReference>();
  for (const group of groups) {
    for (const reference of group) {
      references.set(reference.referenceId, Object.freeze({ ...reference }));
    }
  }
  return [...references.values()];
}

function collectKnowledgeMaintenanceProducedPaths(
  entries: readonly SessionEntry[]
): string[] {
  const paths = new Set<string>();
  for (const entry of entries) {
    if (
      entry.type !== "message"
      || entry.message.role !== "toolResult"
      || entry.message.toolName !== PI_KNOWLEDGE_MAINTAIN_TOOL_ID
      || entry.message.isError
      || !entry.message.details
      || typeof entry.message.details !== "object"
      || Array.isArray(entry.message.details)
    ) continue;
    const details = entry.message.details as Record<string, unknown>;
    if (details.status !== "completed" || !Array.isArray(details.producedPaths)) {
      continue;
    }
    for (const value of details.producedPaths) {
      if (typeof value !== "string" || !value.trim()) continue;
      paths.add(value.trim().replace(/\\/gu, "/"));
    }
  }
  return [...paths].sort();
}

type KnowledgeMaintenanceResultClassification = Readonly<{
  kind: "invalid" | "natural_success" | "trusted_success" | "trusted_failure";
  toolCallIds: readonly string[];
}>;

function classifyKnowledgeMaintenanceResult(
  entries: readonly SessionEntry[],
  allowedToolCallIds?: ReadonlySet<string>,
  providedSourcePaths: readonly string[] = collectMaintenanceReadPaths(entries)
): KnowledgeMaintenanceResultClassification {
  const toolCallIds = collectKnowledgeMaintenanceToolCallIds(
    entries,
    allowedToolCallIds
  );
  const results: Array<Extract<AgentMessage, { role: "toolResult" }>> = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    if (
      entry.message.role === "toolResult"
      && entry.message.toolName === PI_KNOWLEDGE_MAINTAIN_TOOL_ID
      && (
        !allowedToolCallIds
        || allowedToolCallIds.has(entry.message.toolCallId)
      )
    ) {
      results.push(entry.message);
    }
  }
  const affectedToolCallIds = [...new Set([
    ...toolCallIds,
    ...results.map((result) => result.toolCallId)
  ])];
  if (!affectedToolCallIds.length) {
    return Object.freeze({ kind: providedSourcePaths.length ? "natural_success" : "invalid", toolCallIds: [] });
  }
  if (new Set(toolCallIds).size !== toolCallIds.length || toolCallIds.some((id) => results.filter((result) => result.toolCallId === id).length !== 1) || results.some((result) => !toolCallIds.includes(result.toolCallId))) {
    return Object.freeze({ kind: "invalid", toolCallIds: affectedToolCallIds });
  }
  let successful = false;
  for (const result of results) {
    const envelope = knowledgeMaintenanceEnvelopeFromToolResult(result);
    if (!envelope) continue; // A blocked/invalid attempt can be corrected in a later call.
    if (envelope.status === "write_uncertain") return Object.freeze({ kind: "trusted_failure", toolCallIds: affectedToolCallIds });
    if (!result.isError && ["completed", "noop", "partial"].includes(envelope.status)) successful = true;
  }
  return Object.freeze({ kind: successful ? "trusted_success" : "trusted_failure", toolCallIds: affectedToolCallIds });
}

function collectMaintenanceReadPaths(entries: readonly SessionEntry[]): string[] {
  const paths = new Set<string>();
  const reads = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    if (entry.message.role === "assistant") {
      for (const part of entry.message.content) {
        if (part.type !== "toolCall" || !["note_read", "knowledge_read"].includes(part.name)) continue;
        const relative: unknown = part.arguments?.relativePath ?? part.arguments?.vaultRelativePath;
        if (typeof relative === "string") reads.set(part.id, relative);
      }
      continue;
    }
    if (entry.message.role !== "toolResult") continue;
    const details = safeRecord(entry.message.details);
    if (entry.message.toolName === PI_KNOWLEDGE_MAINTAIN_TOOL_ID) {
      for (const value of Array.isArray(details?.readSourcePaths) ? details.readSourcePaths : []) if (typeof value === "string") paths.add(value);
      continue;
    }
    if (!["knowledge_read", "note_read"].includes(entry.message.toolName)) continue;
    const relative = reads.get(entry.message.toolCallId);
    if (entry.message.isError) { if (relative) paths.delete(relative); continue; }
    if (relative) paths.add(relative);
    for (const raw of Array.isArray(details?.references) ? details.references : []) {
      const reference = safeRecord(raw);
      if (typeof reference?.vaultRelativePath === "string") paths.add(reference.vaultRelativePath);
    }
  }
  return [...paths];
}

function maintenanceOutcome(execution: ActiveProductRun, entries: readonly SessionEntry[], terminalState: PiProductRunTerminalState, providedSourcePaths: readonly string[] = [], vaultRoot = ""): NonNullable<PiProductRunRecord["maintenance"]> {
  const read = new Set([...providedSourcePaths, ...collectMaintenanceReadPaths(entries)]);
  const processedReceipts = new Set<string>();
  let hasMaintenanceReceipt = false;
  let issues: Array<{ message: string; path?: string; uncertain: boolean }> = [];
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== PI_KNOWLEDGE_MAINTAIN_TOOL_ID) continue;
    hasMaintenanceReceipt = true;
    const result = knowledgeMaintenanceEnvelopeFromToolResult(entry.message);
    const details = safeRecord(entry.message.details);
    if (result && !entry.message.isError && ["completed", "noop", "partial"].includes(result.status)) {
      const resolvedPaths = new Set(result.notes.map((note) => knowledgeRolePath(note.path)));
      for (const value of Array.isArray(details?.processedSourcePaths) ? details.processedSourcePaths : []) if (typeof value === "string") { read.add(value); processedReceipts.add(value); }
      for (const value of Array.isArray(details?.processedSourcePaths) ? details.processedSourcePaths : []) if (typeof value === "string") resolvedPaths.add(knowledgeRolePath(value));
      // Keep the original tool failure in the transcript, but only unresolved
      // issues belong in the final summary. Uncertain writes are never erased.
      issues = issues.filter((issue) => issue.uncertain || !issue.path || !resolvedPaths.has(knowledgeRolePath(issue.path)));
    }
    if (result) issues.push(...result.issues.map((issue) => ({
      message: knowledgeErrorDetail(issue.message), path: issue.path,
      uncertain: result.status === "write_uncertain"
    })));
  }
  const scope = execution.maintenanceScope ?? (execution.knowledgeWorkflow?.kind === "maintain" ? execution.knowledgeWorkflow.command.scope : undefined);
  const expected = scope?.mode === "query" ? scope.candidatePaths : scope && (scope.mode === "exact" || scope.mode === "batch" || (scope.mode === "global" && scope.sourcePaths)) ? scope.sourcePaths! : [...read].filter((value) => knowledgePathRole(vaultRoot, value) === "raw");
  const analysisOnly = execution.permission === "read-only" || execution.mode === "plan";
  const processedSourcePaths = terminalState === "completed" ? expected.filter((source) => hasMaintenanceReceipt ? processedReceipts.has(source) : read.has(source)) : [];
  return Object.freeze({ analysisOnly, processedSourcePaths, pendingSourcePaths: expected.filter((source) => !processedSourcePaths.includes(source)), warnings: [...new Set(issues.map((issue) => issue.message))] });
}

function collectKnowledgeMaintenanceToolCallIds(
  entries: readonly SessionEntry[],
  allowedToolCallIds?: ReadonlySet<string>
): string[] {
  const toolCallIds: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    for (const part of entry.message.content) {
      if (
        part.type === "toolCall"
        && part.name === PI_KNOWLEDGE_MAINTAIN_TOOL_ID
        && (!allowedToolCallIds || allowedToolCallIds.has(part.id))
      ) {
        toolCallIds.push(part.id);
      }
    }
  }
  return toolCallIds;
}

function settleFailedKnowledgeMaintenanceToolCalls(
  projection: PiChatUiViewModel,
  runs: readonly Readonly<PiProductRunRecord>[],
  entries: readonly SessionEntry[]
): void {
  for (const run of runs) {
    if (
      run.terminalState !== "failed"
      || run.knowledge?.workflow !== "maintain"
    ) continue;
    const result = classifyKnowledgeMaintenanceResult(
      entries,
      new Set(run.toolCallIds)
    );
    if (result.kind !== "invalid") continue;
    settleInvalidKnowledgeMaintenanceProjection(
      projection,
      run.productRunId,
      result.toolCallIds
    );
  }
}

function settleInvalidKnowledgeMaintenanceProjection(
  projection: PiChatUiViewModel,
  productRunId: string,
  toolCallIds: readonly string[]
): void {
  const failedToolCallIds = new Set(toolCallIds);
  projection.pendingToolCallIds = projection.pendingToolCallIds.filter(
    (toolCallId) => !failedToolCallIds.has(toolCallId)
  );
  projection.provisionalMessageIds = projection.provisionalMessageIds.filter(
    (messageId) => ![...failedToolCallIds].some(
      (toolCallId) => messageId.endsWith(
        `:tool:${encodeURIComponent(toolCallId)}`
      )
    )
  );
  projection.messages = projection.messages.filter((message) =>
    message.runId !== productRunId
    || ![...failedToolCallIds].some((toolCallId) =>
      message.id.endsWith(`:tool:${encodeURIComponent(toolCallId)}`)
    )
  );
}

function safeProductRunErrorCode(
  promptError: unknown,
  entries: readonly SessionEntry[]
): string {
  const assistant = lastAssistantEntry(entries)?.message as
    | AssistantMessage
    | undefined;
  if (promptError instanceof PiNativeConversationRuntimeError) {
    return `pi_native_${promptError.code}`;
  }
  if (promptError instanceof PiSessionDurabilityError) {
    return `pi_session_${promptError.code}`;
  }
  for (const entry of [...entries].reverse()) {
    if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
    const result = knowledgeMaintenanceEnvelopeFromToolResult(entry.message);
    if (result && ["failed", "write_uncertain"].includes(result.status) && result.issues.length) return knowledgeErrorDetail(result.issues.map((issue) => `${issue.code}${issue.path ? ` (${issue.path})` : ""}: ${issue.message}`).join("\n"));
    if (!result && entry.message.toolName === PI_KNOWLEDGE_MAINTAIN_TOOL_ID && entry.message.isError) {
      const text = entry.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      if (text.trim()) return knowledgeErrorDetail(`维护工具未执行：${text}`);
    }
  }
  if (promptError) return knowledgeErrorDetail(promptError);
  const providerAssistant: AssistantProviderFailure | undefined = assistant;
  if (providerAssistant?.echoInkProviderFailure) return assistantProviderFailureText(providerAssistant);
  if (assistant?.errorMessage) return knowledgeErrorDetail(assistant.errorMessage);
  const providerFailure = safeProviderFailureCode(assistant?.errorMessage);
  if (providerFailure) return providerFailure;
  if (assistant?.stopReason === "length") {
    return "provider_output_limit_reached";
  }
  return assistant?.stopReason === "error"
    ? "provider_run_failed"
    : "pi_native_run_failed";
}

function inspectRecoveryCandidate(
  sessionRoot: string,
  sessionFile: string,
  label: string
): InvalidPiSessionJsonlInspection | ValidPiSessionJsonlInspection {
  try {
    return inspectPiSessionJsonl({ sessionRoot, sessionFile });
  } catch (error) {
    throw new PiNativeConversationRuntimeError(
      "session_recovery_invalid",
      `The Pi Session ${label} is unavailable or outside the controlled Session Root`,
      { cause: error }
    );
  }
}

function assertExactVerifiedRecoveryPrefix(
  source: InvalidPiSessionJsonlInspection,
  recovery: ValidPiSessionJsonlInspection
): void {
  const sourceBytes = readStableInspectionBytes(source);
  const recoveryBytes = readStableInspectionBytes(recovery);
  if (
    source.verifiedPrefixBytes <= 0
    || recoveryBytes.length !== source.verifiedPrefixBytes
    || recovery.entries.length !== source.entries.length
    || !recoveryBytes.equals(
      sourceBytes.subarray(0, source.verifiedPrefixBytes)
    )
  ) {
    throw new PiNativeConversationRuntimeError(
      "session_recovery_invalid",
      "The proposed recovery is not the exact verified prefix of the corrupt Pi Session"
    );
  }
}

function readStableInspectionBytes(
  inspection: InvalidPiSessionJsonlInspection | ValidPiSessionJsonlInspection
): Buffer {
  let bytes: Buffer;
  try {
    bytes = readFileSync(inspection.sourcePath);
  } catch (error) {
    throw new PiNativeConversationRuntimeError(
      "session_recovery_invalid",
      "The Pi Session file became unavailable during recovery validation",
      { cause: error }
    );
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (
    bytes.length !== inspection.sourceByteLength
    || digest !== inspection.sourceSha256
  ) {
    throw new PiNativeConversationRuntimeError(
      "session_recovery_invalid",
      "The Pi Session file changed during recovery validation"
    );
  }
  return bytes;
}

function requireNonEmptyRuntimeString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} is required`);
  }
  return value;
}

function assertDraftIdentity(
  draft: Readonly<PiConversationDraftRecord>,
  catalog: Readonly<PiConversationCatalogEntry>
): void {
  if (
    draft.conversationId !== catalog.conversationId
    || draft.piSessionId !== catalog.piSessionId
  ) {
    throw new PiNativeConversationRuntimeError(
      "draft_invalid",
      `草稿 ${draft.draftId} 与当前 Conversation / Pi Session 身份不一致`
    );
  }
}

function safeRuntimeErrorText(error: unknown): string {
  try {
    const message = error instanceof Error
      ? error.message || error.name
      : typeof error === "string"
        ? error
        : String(error);
    return (message || "pi_native_runtime_interrupted").slice(0, 500);
  } catch {
    return "pi_native_runtime_interrupted";
  }
}

function safePersistedRuntimeErrorCode(error: unknown): string {
  if (error instanceof PiNativeConversationRuntimeError) {
    return `pi_native_${error.code}`;
  }
  if (error instanceof PiSessionDurabilityError) {
    return `pi_session_${error.code}`;
  }
  return "pi_native_runtime_interrupted";
}

function safeProductRunStartFailureCode(error: unknown): string {
  if (error instanceof PiNativeConversationRuntimeError) {
    return safeWhitelistedErrorCode(
      error,
      SAFE_PI_NATIVE_CONVERSATION_RUNTIME_ERROR_CODES
    );
  }
  if (error instanceof PiSessionDurabilityError) {
    return safeWhitelistedErrorCode(
      error,
      SAFE_PI_SESSION_DURABILITY_ERROR_CODES
    );
  }
  if (error instanceof PiNativeFileStoreError) {
    return safeWhitelistedErrorCode(
      error,
      SAFE_PI_NATIVE_FILE_STORE_ERROR_CODES
    );
  }
  return "unknown";
}

function safeWhitelistedErrorCode(
  error: Readonly<{ code: unknown }>,
  allowedCodes: ReadonlySet<string>
): string {
  try {
    const code = error.code;
    return typeof code === "string" && allowedCodes.has(code)
      ? code
      : "unknown";
  } catch {
    return "unknown";
  }
}

function normalizeAgentSessionWarning(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replaceAll("\u0000", " ")
    .replace(/[\r\n]+/gu, " ")
    .trim()
    .slice(0, 500);
}

function lastEntryOfType(
  entries: readonly SessionEntry[],
  type: SessionEntry["type"]
): SessionEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].type === type) return entries[index];
  }
  return undefined;
}

function runIdentity(run: Readonly<PiProductRunRecord>): PiChatUiRunIdentity {
  return {
    productRunId: run.productRunId,
    userEntryId: run.userEntryId,
    assistantEntryId: run.assistantEntryId,
    toolCallIds: run.toolCallIds,
    updatedAt: run.updatedAt,
    ...(run.knowledge
      ? { knowledgeWorkflow: run.knowledge.workflow }
      : {})
  };
}

function terminalRunState(
  run: Readonly<PiProductRunRecord> | undefined
): PiChatUiViewModel["runState"] {
  if (!run?.terminalState) return "idle";
  return run.terminalState;
}

function executionContext(
  productRunId: string,
  conversationId: string
): PiNativeProviderExecutionContext {
  return Object.freeze({
    runId: productRunId,
    conversationId,
    turnId: productRunId,
    correlationId: productRunId
  });
}

function createSettlementBarrier(): PiProductRunSettlementBarrier {
  let resolvePromise: (() => void) | undefined;
  let resolved = false;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (resolved) return;
      resolved = true;
      resolvePromise?.();
    }
  };
}

function productRunStartFailure(
  primaryError: unknown,
  cleanupErrors: readonly unknown[],
  message: string
): Error {
  if (cleanupErrors.length === 0 && primaryError instanceof Error) {
    return primaryError;
  }
  return new AggregateError(
    [primaryError, ...cleanupErrors],
    message
  );
}

function productRunStartFailureAfterUserEntry(
  primaryError: unknown,
  cleanupErrors: readonly unknown[],
  message: string,
  userEntryId: string
): PiNativeConversationRuntimeError {
  return new PiNativeConversationRuntimeError(
    "product_run_start_failed_after_user_entry",
    message,
    {
      cause: productRunStartFailure(primaryError, cleanupErrors, message),
      piUserEntryAccepted: true,
      piUserEntryId: userEntryId
    }
  );
}

export function agentSessionSupportsImageInput(
  session: Pick<AgentSession, "model">
): boolean {
  return piModelSupportsImageInput(session.model);
}

function normalizePiChatPreparedImages(
  values: readonly Readonly<PiChatPreparedImage>[] | undefined
): ImageContent[] {
  if (!values?.length) return [];
  return values.map((value, index) => {
    const content = value?.content;
    const attachment = value?.attachment;
    const invalid =
      !content
      || content.kind !== "inline_image"
      || content.preflight !== "approved"
      || !isPiInlineImageMimeType(content.mimeType)
      || !validInlineImageBase64(content.data)
      || !attachment
      || attachment.type !== "image"
      || !attachment.name?.trim()
      || !attachment.path?.trim()
      || !isPiLocalImageMimeType(attachment.mimeType)
      || "data" in attachment
      || "base64" in attachment;
    if (invalid) {
      throw new PiNativeConversationRuntimeError(
        "agent_session_invalid",
        `Pi 图片输入 ${index + 1} 未通过提交契约。`
      );
    }
    return {
      type: "image",
      data: content.data,
      mimeType: content.mimeType
    };
  });
}

function piInlineImagesInMessages(
  messages: readonly Readonly<AgentMessage>[]
): ImageContent[] {
  const images: ImageContent[] = [];
  for (const message of messages) {
    const content = (message as Readonly<{ content?: unknown }>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        block
        && typeof block === "object"
        && (block as { type?: unknown }).type === "image"
        && typeof (block as { data?: unknown }).data === "string"
        && isPiInlineImageMimeType((block as { mimeType?: unknown }).mimeType)
      ) {
        const image = block as Readonly<ImageContent>;
        images.push({
          type: "image",
          data: image.data,
          mimeType: image.mimeType
        });
      }
    }
  }
  return images;
}

function isPiInlineImageMimeType(value: unknown): value is ImageContent["mimeType"] {
  return value === "image/png"
    || value === "image/jpeg"
    || value === "image/gif"
    || value === "image/webp";
}

function isPiLocalImageMimeType(value: unknown): value is string {
  return isPiInlineImageMimeType(value)
    || value === "image/bmp"
    || value === "image/heic"
    || value === "image/heif"
    || value === "image/svg+xml";
}

function validInlineImageBase64(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length % 4 === 0
    && /^[A-Za-z0-9+/]+={0,2}$/.test(value)
    && Buffer.from(value, "base64").byteLength > 0;
}

function combinedOperationError(
  errors: readonly unknown[],
  message: string
): Error {
  if (errors.length === 1 && errors[0] instanceof Error) return errors[0];
  return new AggregateError(errors, message);
}

function maintenanceCommandContext(
  command: Extract<
    KnowledgeConversationCommand,
    { kind: "maintain" }
  >,
  preference: Readonly<{
    profileVersion: string;
    state: "default" | "custom";
    revision: string;
    providerResourceText: string;
  }>,
  scopeValue: PiKnowledgeMaintenanceScope | undefined
): Readonly<PiKnowledgeMaintenanceCommandContext> {
  const scope = normalizePiKnowledgeMaintenanceScope(
    scopeValue,
    command.request
  );
  return Object.freeze({
    mode: "maintain",
    request: command.request,
    scope,
    preference: Object.freeze({ ...preference })
  });
}

function normalizePiKnowledgeMaintenanceScope(
  value: PiKnowledgeMaintenanceScope | undefined,
  request: string
): PiKnowledgeMaintenanceScope {
  if (!value) {
    throw new PiNativeConversationRuntimeError(
      "agent_session_invalid",
      "Knowledge maintenance scope is unresolved"
    );
  }
  if (value.mode === "global") {
    if (request.trim()) {
      throw new PiNativeConversationRuntimeError(
        "agent_session_invalid",
        "Knowledge maintenance query cannot fall back to global scope"
      );
    }
    return Object.freeze({ ...value, mode: "global" as const, ...(value.sourcePaths ? { sourcePaths: Object.freeze(value.sourcePaths.map(normalizePiKnowledgeMaintenanceRawPath)) } : {}) });
  }
  if (value.mode === "exact") {
    if (request.trim() || value.sourcePaths.length !== 1) {
      throw new PiNativeConversationRuntimeError(
        "agent_session_invalid",
        "Knowledge maintenance exact scope is invalid"
      );
    }
    return Object.freeze({
      mode: "exact" as const,
      sourcePaths: Object.freeze<[string]>([
        normalizePiKnowledgeMaintenanceRawPath(value.sourcePaths[0])
      ])
    });
  }
  if (value.mode === "batch") {
    // Initialization supplies instructions as well as a frozen source list.
    // Unlike a query name, that text does not select or widen the batch scope.
    if (
      value.sourcePaths.length === 0
      || value.sourcePaths.length > 20
    ) {
      throw new PiNativeConversationRuntimeError(
        "agent_session_invalid",
        `本批知识分析包含 ${value.sourcePaths.length} 篇笔记，每批必须为 1–20 篇。尚未开始分析，已完成的整理保留。`
      );
    }
    const sourcePaths = value.sourcePaths.map(
      normalizePiKnowledgeMaintenanceRawPath
    );
    if (new Set(sourcePaths).size !== sourcePaths.length) {
      throw new PiNativeConversationRuntimeError(
        "agent_session_invalid",
        "本批知识分析重复列出了同一篇笔记。尚未开始分析，已完成的整理保留。"
      );
    }
    return Object.freeze({
      mode: "batch" as const,
      sourcePaths: Object.freeze(sourcePaths)
    });
  }
  if (
    value.mode !== "query"
    || !request.trim()
    || value.candidatePaths.length === 0
    || value.candidatePaths.length > 12
  ) {
    throw new PiNativeConversationRuntimeError(
      "agent_session_invalid",
      "Knowledge maintenance query scope is invalid"
    );
  }
  const candidatePaths = [...new Set(value.candidatePaths.map(
    normalizePiKnowledgeMaintenanceRawPath
  ))];
  if (!candidatePaths.length) {
    throw new PiNativeConversationRuntimeError(
      "agent_session_invalid",
      "Knowledge maintenance query has no Raw candidates"
    );
  }
  return Object.freeze({
    mode: "query" as const,
    candidatePaths: Object.freeze(candidatePaths)
  });
}

function normalizePiKnowledgeMaintenanceRawPath(value: string): string {
  const normalized = String(value).trim().replaceAll("\\", "/").replace(/^\/+/, "");
  if (
    !isRawMarkdownPath(normalized)
    || normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new PiNativeConversationRuntimeError(
      "agent_session_invalid",
      "Knowledge maintenance source must be one Raw Markdown note"
    );
  }
  return normalized;
}

function createKnowledgeObservation(
  workflow: PiKnowledgeObservation["workflow"],
  retrieval: Readonly<PiKnowledgeRetrievalObservation> | null,
  command?: Readonly<PiKnowledgeMaintenanceCommandContext>
): MutablePiKnowledgeObservation {
  const observation: MutablePiKnowledgeObservation = {
    workflow,
    localRetrievalElapsedMs: retrieval?.elapsedMs ?? 0,
    candidates: retrieval?.total ?? 0,
    returned: retrieval?.returned ?? 0,
    remaining: retrieval?.remaining ?? 0,
    hasMore: retrieval?.hasMore ?? false,
    exhausted: retrieval?.exhausted ?? true,
    continuationCount: 0,
    knowledgeReadCount: 0,
    memoryRecallUsed: false,
    memorySearchUsed: false,
    memoryReadUsed: false,
    conflictOrFreshnessTriggered: false
  };
  if (workflow === "maintain"
    || workflow === "maintain_preview"
    || workflow === "maintain_confirm") {
    observation.protocolVersion =
      ECHOINK_KNOWLEDGE_MAINTENANCE_PROTOCOL_VERSION;
  }
  if (command?.mode === "maintain") {
    observation.preferenceProfileVersion = command.preference.profileVersion;
    observation.preferenceState = command.preference.state;
  }
  return observation;
}

function freezeKnowledgeObservation(
  input: Readonly<MutablePiKnowledgeObservation>
): Readonly<PiKnowledgeObservation> {
  return Object.freeze({
    workflow: input.workflow,
    localRetrievalElapsedMs: input.localRetrievalElapsedMs,
    candidates: input.candidates,
    returned: input.returned,
    remaining: input.remaining,
    hasMore: input.hasMore,
    exhausted: input.exhausted,
    continuationCount: input.continuationCount,
    knowledgeReadCount: input.knowledgeReadCount,
    memoryRecallUsed: input.memoryRecallUsed,
    memorySearchUsed: input.memorySearchUsed,
    memoryReadUsed: input.memoryReadUsed,
    conflictOrFreshnessTriggered: input.conflictOrFreshnessTriggered,
    ...(input.modelFirstTextLatencyMs === undefined
      ? {}
      : { modelFirstTextLatencyMs: input.modelFirstTextLatencyMs }),
    ...(input.protocolVersion
      ? { protocolVersion: input.protocolVersion }
      : {}),
    ...(input.preferenceProfileVersion
      ? { preferenceProfileVersion: input.preferenceProfileVersion }
      : {}),
    ...(input.preferenceState
      ? { preferenceState: input.preferenceState }
      : {})
  });
}

function knowledgeToolProgressStage(
  execution: Readonly<ActiveProductRun>,
  toolName: string,
  args: unknown,
  externalReadToolNames: readonly string[]
): Extract<
  PiChatRuntimeEvent,
  { type: "knowledge_progress" }
>["stage"] | null {
  if (execution.knowledgeObservation?.workflow === "ask"
    || execution.knowledgeObservation?.workflow === "chat") {
    if (toolName === "knowledge_search") {
      return safeRecord(args)?.cursor ? "continuing_search" : "searching";
    }
    if (toolName === "knowledge_read" || toolName === "note_read") {
      return "reading_knowledge";
    }
    if (execution.knowledgeObservation.workflow === "ask"
      && (toolName === "memory_search" || toolName === "memory_read")) {
      return "comparing_memory";
    }
  }
  if (toolName === PI_KNOWLEDGE_MAINTAIN_TOOL_ID) {
    return "writing_and_readback";
  }
  if (externalReadToolNames.includes(toolName)) {
    return "checking_conflicts_freshness";
  }
  return null;
}

function runtimeToolPayloadForProjection(
  execution: Readonly<ActiveProductRun>,
  toolName: string,
  payload: unknown,
  isError = false
): unknown {
  if (!execution.knowledgeObservation) {
    return payload;
  }
  if (toolName === PI_KNOWLEDGE_MAINTAIN_TOOL_ID) {
    const maintenanceResult = knowledgeMaintenanceEnvelopeFromToolResult(payload);
    if (maintenanceResult) {
      return Object.freeze({
        status: isError ? "failed" : "completed",
        maintenanceResult
      });
    }
  }
  const metadata = piKnowledgeToolDisplayMetadata(toolName, payload);
  return Object.freeze({
    status: isError ? "failed" : "completed",
    details: isError
      ? metadata.errorCode ? { errorCode: metadata.errorCode } : {}
      : metadata
  });
}

function knowledgeToolIsPrivacySafe(
  execution: Readonly<ActiveProductRun>,
  _toolName: string
): boolean {
  return Boolean(execution.knowledgeObservation);
}

function safeAgentToolResultDetails(
  result: unknown
): Readonly<Record<string, unknown>> | null {
  const outer = safeRecord(result);
  return safeRecord(outer?.details) ?? outer;
}

function reasoningToolWasCancelled(result: unknown): boolean {
  const record = safeRecord(result);
  if (!record) return false;
  const status = typeof record.status === "string"
    ? record.status.trim().toLowerCase()
    : "";
  return record.cancelled === true
    || record.canceled === true
    || status === "cancelled"
    || status === "canceled";
}

function safeRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function safeNonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : null;
}

function safeVersionToken(value: unknown): string | null {
  if (
    typeof value !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(value)
  ) return null;
  return value;
}

function resourceKeyFor(
  options: ActivatePiNativeConversationOptions
): string {
  return [
    options.skillPath ?? "",
    options.skillName ?? "",
    options.skillRevision ?? "",
    ...(options.skillPaths ?? []),
    ...(options.skillNames ?? [])
  ].join("\0");
}

function normalizePiChatMode(value: unknown): PiChatMode {
  if (value === undefined || value === "agent") return "agent";
  if (value === "plan") return "plan";
  throw new TypeError("Pi Chat mode must be agent or plan");
}

function assertValidSkillBinding(
  options: Readonly<ActivatePiNativeConversationOptions>
): void {
  const singleValid = Boolean(options.skillPath) === Boolean(options.skillName);
  const paths = options.skillPaths ?? [];
  const names = options.skillNames ?? [];
  const hasBinding = Boolean(options.skillPath) || paths.length > 0;
  const revisionValid = options.skillRevision === undefined
    || (hasBinding && /^[a-f0-9]{64}$/u.test(options.skillRevision));
  const setValid = paths.length === names.length
    && new Set(paths).size === paths.length
    && new Set(names).size === names.length;
  if (singleValid && setValid && revisionValid
    && !(options.skillPath && paths.length > 0)) return;
  throw new PiNativeConversationRuntimeError(
    "skill_binding_invalid",
    "Pi-native Skill requires one binding form with matching unique paths and names"
  );
}

function dailyJournalSkillTurnContext(input: Readonly<{
  selectedSkillIds: readonly string[];
}>): Readonly<PiNativeSkillTurnContext> | null {
  if (!input.selectedSkillIds.includes("daily-journal")) return null;
  return Object.freeze({
    skillId: "daily-journal",
    content: [
      "当前使用 daily-journal Skill。直接交流，用户继续表达时继续聊；开场不检查文件、模板或目录。",
      "用户明确要保存时，再调用 obsidian_context 获取当前原生日记设置、当天精确路径和已渲染模板，使用现有 note 工具保存。"
    ].join("\n")
  });
}

function requireSkillCommandName(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(normalized)) {
    throw new PiNativeConversationRuntimeError(
      "skill_binding_invalid",
      "Pi-native selected Skill requires a command-safe ResourceLoader alias"
    );
  }
  return normalized;
}

function reasoningTaskActivityStatus(
  status: EchoInkTaskPlanSnapshot["status"]
): EchoInkReasoningActivityStatus {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "paused") return "interrupted";
  if (status === "cancelled") return "cancelled";
  return "active";
}

function reasoningSummaryTerminalStatus(
  terminalState: PiProductRunTerminalState,
  abortRequested: boolean
): Exclude<EchoInkReasoningSummaryStatus, "running"> {
  if (terminalState === "completed") return "completed";
  if (terminalState === "failed") return "failed";
  return abortRequested ? "cancelled" : "interrupted";
}

function safeIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(value);
}

/** Reconstruct a missing stop-stage from the selected durable Branch without runtime activation. */
export function readDurableTaskInterruptionStage(input: {
  catalogStore: Pick<FileConversationCatalog, "sessionRootPath">;
  catalog: Readonly<PiConversationCatalogEntry>;
  runs: readonly Readonly<PiProductRunRecord>[];
  productRunId: string;
}): string {
  const run = input.runs.find(run => run.productRunId === input.productRunId);
  if (!run || run.piSessionId !== input.catalog.piSessionId || !input.catalog.sessionFile) return "";
  const inspected = inspectPiSessionJsonl({ sessionRoot: input.catalogStore.sessionRootPath, sessionFile: input.catalog.sessionFile });
  if (!inspected.valid || inspected.header.id !== input.catalog.piSessionId) return "";
  const checkpoint = readPiActiveLeafCheckpoint({ sessionRoot: input.catalogStore.sessionRootPath, piSessionId: input.catalog.piSessionId });
  const leafId = checkpoint ? checkpoint.activeLeafId : inspected.entries.at(-1)?.id ?? null;
  const byId = new Map(inspected.entries.map(entry => [entry.id, entry]));
  const branch: SessionEntry[] = [];
  for (let id = leafId; id !== null;) {
    const entry = byId.get(id);
    if (!entry) return "";
    branch.push(entry); id = entry.parentId;
  }
  branch.reverse();
  if (!branch.some(entry => entry.id === run.userEntryId)) return "";
  const projection = new PiChatUiProjector().projectSessionBranch({
    piSessionId: input.catalog.piSessionId, activeLeafId: leafId, entries: branch,
    productRunId: run.productRunId, runIdentities: input.runs.map(runIdentity), runState: "running", now: run.updatedAt
  });
  return taskInterruptionStage({ catalog: input.catalog, sessionManager: { getBranch: () => branch }, projection, currentRun: run });
}

/** Use recorded task steps or display-safe live Tool titles, never Tool payloads. */
function taskInterruptionStage(active: {
  catalog: Pick<PiConversationCatalogEntry, "taskStage">;
  sessionManager: Pick<SessionManager, "getBranch">;
  projection: Pick<PiChatUiViewModel, "messages">;
  currentRun?: Pick<ActiveProductRun, "productRunId"> | null;
  pendingSettlement?: Pick<ActiveProductRun, "productRunId"> | null;
}): string {
  if (active.catalog.taskStage?.trim()) return active.catalog.taskStage.trim().slice(0, 500);
  const plan = latestTaskPlanFromBranch(active.sessionManager.getBranch());
  const step = plan?.steps.find(step => step.stepId === plan.currentStepId);
  if (step?.text.trim()) return step.text.trim().slice(0, 500);
  const runId = active.currentRun?.productRunId ?? active.pendingSettlement?.productRunId;
  if (!runId) return "";
  const candidates: { title: string; at: number }[] = [];
  for (const message of active.projection.messages) {
    const turn = message.assistantTurn;
    if (turn?.turnId === runId) for (const node of turn.processNodes) {
      if (node.kind === "tool" && (node.status === "running" || node.status === "waiting") && node.title.trim()) {
        candidates.push({ title: node.title.trim(), at: node.updatedAt });
      }
    }
    if ((message.runId === runId || message.turnId === runId) && message.role === "tool"
      && ["running", "pending", "waiting", "waiting_approval"].includes(message.status ?? "") && message.title?.trim()) {
      candidates.push({ title: message.title.trim(), at: message.createdAt });
    }
  }
  return candidates.sort((left, right) => right.at - left.at)[0]?.title.slice(0, 500) ?? "";
}
