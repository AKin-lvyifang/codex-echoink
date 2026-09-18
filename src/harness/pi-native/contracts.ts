import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { PiPreparedInlineImage } from "../pi/contracts";
import type { PiContextLedger } from "./pi-context-budget";
import type {
  ChatMessage,
  PersonalMemorySourceReference
} from "../../settings/settings";
import type {
  KnowledgeMaintenanceAssessment,
  KnowledgeMaintenanceResultEnvelope
} from "../../knowledge-base/knowledge-maintenance-result";
import type {
  EchoInkTaskPlanSnapshot
} from "../../types/task-plan";
import type {
  EchoInkReasoningSummarySnapshot
} from "../../types/reasoning-summary";
import type { PermissionMode, ReasoningEffort } from "../../types/app-server";
import type {
  EchoInkTurnInteraction,
  EchoInkTurnInteractionRecord
} from "../../types/conversation-turn";

export type PiConversationMemoryMode = "normal" | "no_memory";
export type PiChatMode = "agent" | "plan";
export type PiConversationCatalogStatus = "active" | "archived" | "deleted";

export const PI_IMAGE_INPUT_UNSUPPORTED_MESSAGE =
  "当前模型不支持图片输入，请切换支持图片的模型。";

export interface PiConversationCatalogEntry {
  conversationId: string;
  piSessionId: string;
  vaultId: string;
  title: string;
  status: PiConversationCatalogStatus;
  defaultMemoryMode: PiConversationMemoryMode;
  /** Optional product-owned Skill resolved again before every formal Turn. */
  defaultSkillId?: string;
  /** Journal directory frozen when a daily-journal Conversation is created. */
  journalDirectory?: string;
  createdAt: number;
  updatedAt: number;
  /** Pi-owned JSONL path. This is an index pointer, never a transcript copy. */
  sessionFile?: string;
}

export interface PiConversationDraftRecord {
  draftId: string;
  conversationId: string;
  piSessionId: string;
  source: "steering" | "follow_up" | "abort" | "restart";
  text: string;
  createdAt: number;
}

export interface PiConversationDiagnostic {
  diagnosticId: string;
  conversationId: string;
  piSessionId: string;
  code:
    | "session_jsonl_malformed"
    | "session_jsonl_truncated"
    | "session_recovered_prefix"
    | "model_metadata_incompatible"
    | "runtime_resource_warning"
    | "runtime_interrupted";
  message: string;
  sourcePath?: string;
  recoveryPath?: string;
  createdAt: number;
}

export type PiProductRunTerminalState =
  | "completed"
  | "failed"
  | "cancelled";

export type PiProductRunState =
  | "accepted"
  | "running"
  | "agent_settled"
  | "finalizing"
  | "product_run_settled";

export interface PiMemoryRecallObservation {
  readonly result: "completed" | "skipped_no_memory" | "failed";
  readonly stage: "loading" | "catalog" | "matching" | "budgeting" | "assembling";
  readonly elapsedMs: number;
  readonly scanned: number;
  readonly candidates: number;
  readonly injected: number;
  readonly remaining: number;
  readonly exhausted: boolean;
}

/**
 * Privacy-safe Knowledge Agent diagnostics persisted with one ProductRun.
 *
 * This summary deliberately excludes queries, paths, excerpts, revisions,
 * Tool payloads, Provider Tool ids, credentials, and exception text.
 */
export interface PiKnowledgeObservation {
  /** Legacy maintain values are read-only compatibility for durable ProductRuns. */
  readonly workflow:
    | "chat"
    | "ask"
    | "maintain"
    | "maintain_preview"
    | "maintain_confirm";
  readonly localRetrievalElapsedMs: number;
  readonly candidates: number;
  readonly returned: number;
  readonly remaining: number;
  readonly hasMore: boolean;
  readonly exhausted: boolean;
  readonly continuationCount: number;
  readonly knowledgeReadCount: number;
  readonly memoryRecallUsed: boolean;
  readonly memorySearchUsed: boolean;
  readonly memoryReadUsed: boolean;
  readonly conflictOrFreshnessTriggered: boolean;
  readonly modelFirstTextLatencyMs?: number;
  readonly protocolVersion?: string;
  readonly preferenceProfileVersion?: string;
  readonly preferenceState?: "default" | "custom";
}

export interface PiProductRunRecord {
  productRunId: string;
  conversationId: string;
  piSessionId: string;
  userEntryId: string;
  assistantEntryId?: string;
  toolCallIds: string[];
  memoryMode: PiConversationMemoryMode;
  /** Absent only in historical runs; new runs persist the submitted permission. */
  permission?: PermissionMode;
  state: PiProductRunState;
  terminalState?: PiProductRunTerminalState;
  activeLeafId: string | null;
  agentSettledAt?: number;
  settledAt?: number;
  error?: string;
  memoryRecall?: PiMemoryRecallObservation;
  knowledge?: PiKnowledgeObservation;
  createdAt: number;
  updatedAt: number;
}

/**
 * Read-only Phase 1 source pointer for a future Phase 4 Experience.
 *
 * It deliberately contains no message body, Tool Result, transcript, or
 * projection payload. Callers must resolve it again before use so deleting the
 * source Conversation invalidates an already persisted reference.
 */
export interface ExperienceSourceRef {
  readonly sourceEventId: string;
  readonly vaultId: string;
  readonly conversationId: string;
  readonly piSessionId: string;
  readonly userEntryId: string;
  readonly assistantEntryId?: string;
  readonly productRunId: string;
  readonly memoryMode: PiConversationMemoryMode;
  readonly terminalState: PiProductRunTerminalState;
}

/** Structural Phase 3 pointer; the Vault file remains the only content source. */
export interface PiKnowledgeReference {
  readonly referenceId: string;
  readonly vaultRelativePath: string;
  readonly title: string;
  readonly excerpt: string;
  readonly contentRevision: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly sourceType?: "wiki" | "projects" | "raw";
  readonly recordedAt?: number;
  readonly publishedAt?: string;
  readonly verificationStatus?: "local_revision_verified" | "source_link_changed";
}

export interface PiKnowledgeRunIdentity {
  readonly vaultId: string;
  readonly conversationId: string;
  readonly piSessionId: string;
  readonly productRunId: string;
}

export interface PiKnowledgeRetrievalObservation {
  readonly elapsedMs: number;
  readonly total: number;
  readonly returned: number;
  readonly remaining: number;
  readonly hasMore: boolean;
  readonly exhausted: boolean;
}

export type PiKnowledgeAskPreflightResult =
  | Readonly<{
      status: "ready";
      references: readonly Readonly<PiKnowledgeReference>[];
      /** Already redacted and Egress-approved hidden Resource text. */
      providerResourceText: string;
      retrieval: Readonly<PiKnowledgeRetrievalObservation>;
    }>
  | Readonly<{
      status: "no_evidence";
      references: readonly Readonly<PiKnowledgeReference>[];
      /** Hidden instruction; `/ask` still enters the same Pi AgentSession. */
      providerResourceText: string;
      retrieval: Readonly<PiKnowledgeRetrievalObservation>;
    }>;

export type PiKnowledgeReferenceVerificationResult =
  | Readonly<{
      status: "valid";
      references: readonly Readonly<PiKnowledgeReference>[];
    }>
  | Readonly<{
      status: "source_changed";
      fixedResponse: "来源已变化，请重新执行";
      changedReferenceIds: readonly string[];
    }>;

export interface PiKnowledgeUsageEvent {
  readonly sourceEventId: string;
  readonly vaultId: string;
  readonly conversationId: string;
  readonly piSessionId: string;
  readonly piEntryId: string;
  readonly productRunId: string;
  readonly referenceIds: readonly string[];
  readonly workflow: "normal_read" | "ask" | "maintain";
  readonly producedPaths: readonly string[];
  /** Present only for `/ask`; contains no Memory body or retrieval clues. */
  readonly personalMemorySources?: readonly Readonly<PersonalMemorySourceReference>[];
}

/** Phase 3 domain seam; structural preparation is explicit and write-authorized. */
export interface PiKnowledgeRuntimePort {
  prepareMaintenanceStructure?(input: { initialization: boolean; assertActive(): void }): Promise<string>;
  resolveMaintenanceScope?(request: string): Promise<PiKnowledgeMaintenanceScope>;
  prepareMaintenancePreferences?(): Promise<Readonly<{
    profileVersion: string;
    state: "default" | "custom";
    revision: string;
    /** Already bounded hidden Resource text for the current turn. */
    providerResourceText: string;
  }>>;
  retrieveAsk(input: Readonly<
    PiKnowledgeRunIdentity & {
      question: string;
      explicitPaths: readonly string[];
      includeUnrefined: boolean;
    }
  >): Promise<PiKnowledgeAskPreflightResult>;
  retrieveChat?(input: Readonly<
    PiKnowledgeRunIdentity & {
      question: string;
      explicitPaths: readonly string[];
      includeUnrefined: boolean;
    }
  >): Promise<PiKnowledgeAskPreflightResult>;
  verifyAskReferences(input: Readonly<
    PiKnowledgeRunIdentity & {
      references: readonly Readonly<PiKnowledgeReference>[];
    }
  >): Promise<PiKnowledgeReferenceVerificationResult>;
  recordUsage?(input: Readonly<{
    event: Readonly<PiKnowledgeUsageEvent>;
    /** Active Pi Branch read back after the target Entry is durable. */
    entries: readonly SessionEntry[];
  }>): Promise<void>;
  finalizeNormalRead?(input: Readonly<
    PiKnowledgeRunIdentity & {
      question: string;
      noteReadPaths: readonly string[];
      assistantEntryId: string;
      entries: readonly SessionEntry[];
    }
  >): Promise<void>;
  finalizeMaintenance?(input: Readonly<
    PiKnowledgeRunIdentity & {
      noteReadPaths: readonly string[];
      producedPaths: readonly string[];
      assistantEntryId: string;
      entries: readonly SessionEntry[];
    }
  >): Promise<void>;
}

export interface PiKnowledgeMaintenanceToolInput extends PiKnowledgeRunIdentity {
  readonly toolCallId: string;
  readonly mode: "maintain";
  readonly request: string;
  readonly sourcePaths?: readonly string[];
  /** Content-addressed preference snapshot captured before this Tool loop. */
  readonly preferenceSnapshot?: Readonly<{
    profileVersion: string;
    state: "default" | "custom";
    revision: string;
  }>;
  /** Generated by the same AgentSession before the single Tool executes. */
  readonly candidateActions?: readonly Readonly<{
    targetPath: string;
    content: string;
    expectedTarget: Readonly<
      | { kind: "missing" }
      | { kind: "file"; contentRevision: string }
    >;
  }>[];
  readonly assessments?: readonly Readonly<KnowledgeMaintenanceAssessment>[];
  readonly signal?: AbortSignal;
}

export interface PiKnowledgeMaintenanceToolResult {
  readonly status: "completed" | "failed" | "cancelled";
  readonly message: string;
  readonly producedPaths?: readonly string[];
  readonly maintenanceResult?: Readonly<KnowledgeMaintenanceResultEnvelope>;
  /** Safe structured metadata for ProductRun diagnostics; never content hashes. */
  readonly protocolVersion?: string;
  readonly preferenceProfileVersion?: string;
  readonly preferenceState?: "default" | "custom";
  readonly errorCode?:
    | "invalid_input"
    | "invalid_raw_path"
    | "proposal_invalid"
    | "preview_not_found"
    | "preview_inactive"
    | "preview_stale"
    | "approval_failed"
    | "wal_conflict"
    | "write_failed"
    | "write_uncertain"
    | "recovery_blocked"
    | "knowledge_maintenance_failed";
}

/** Typed Phase 3 seam; the maintenance implementation remains one Pi Tool. */
export interface PiKnowledgeMaintenanceToolPort {
  execute(
    input: Readonly<PiKnowledgeMaintenanceToolInput>
  ): Promise<Readonly<PiKnowledgeMaintenanceToolResult>>;
}

export interface PiChatSubmitRequest {
  conversationId: string;
  text: string;
  submittedAt: number;
  /** Ordered Pi-ready image content paired with local-only display metadata. */
  images?: readonly Readonly<PiChatPreparedImage>[];
  /** Ordered locally extracted document snapshots frozen for this submitted turn. */
  documents?: readonly Readonly<PiChatPreparedDocument>[];
  /** Ordered whole-note snapshots frozen for this exact submitted turn. */
  noteMentions?: readonly Readonly<PiChatNoteMention>[];
  /** The composer mode captured for this exact queued turn. */
  mode?: PiChatMode;
  /** Workspace permission frozen when this message was sent, including queued turns. */
  permission?: PermissionMode;
  /** Saved Provider configuration identity captured with this exact turn. */
  providerSettingsId?: string;
  /** Runtime Provider identity captured with this exact Composer turn. */
  runtimeProviderId: string;
  /** Model identity captured with this exact Composer turn. */
  modelId: string;
  /** Exact per-turn selection to map to Pi's Provider thinking level. */
  reasoning: ReasoningEffort;
  memoryMode?: PiConversationMemoryMode;
  /** Stable Resource identity for runtime policy; never inferred from display name. */
  skillId?: string;
  skillPath?: string;
  skillName?: string;
  /** A durable queued draft explicitly selected by the user for resubmission. */
  draftId?: string;
  maintenanceScope?: PiKnowledgeMaintenanceScope;
}

export interface PiChatNoteMention {
  readonly vaultRelativePath: string;
  readonly fileName: string;
  readonly content: string;
}

export interface PiChatPreparedImage {
  content: Readonly<PiPreparedInlineImage>;
  attachment: Readonly<{
    type: "image";
    name: string;
    path: string;
    /** MIME detected from the local source, not a second model payload. */
    mimeType: string;
  }>;
}

export interface PiChatPreparedDocument {
  readonly attachment: Readonly<{
    type: "file";
    name: string;
    path: string;
    mimeType: string;
    sizeBytes: number;
    availability: "available" | "unavailable";
  }>;
  readonly kind: "pdf" | "word" | "markdown" | "html";
  /** Immutable byte snapshot copied before this turn is sent or enqueued. */
  readonly bytes: Readonly<Uint8Array>;
  /** Lowercase SHA-256 of bytes, used to prove queue and replay identity. */
  readonly sha256: string;
  /** Frozen transport selected from the exact product capability matrix. */
  readonly transport: "native" | "extracted_text";
  /** Local fallback text. Required for extracted_text; optional for native PDF. */
  readonly text?: string;
}

export type PiKnowledgeMaintenanceScope = Readonly<
  | { mode: "global" }
  | { mode: "exact"; sourcePaths: readonly [string] }
  | { mode: "batch"; sourcePaths: readonly string[] }
  | { mode: "query"; candidatePaths: readonly string[] }
>;

export interface PiTaskPlanTransitionRequest {
  readonly conversationId: string;
  readonly planId: string;
  readonly action: "execute" | "continue" | "pause" | "cancel";
}

export interface PiTaskPlanTransitionResult {
  readonly plan: Readonly<EchoInkTaskPlanSnapshot>;
  readonly activeLeafId: string | null;
}

export interface PiChatRunHandle {
  productRunId: string;
  conversationId: string;
  piSessionId: string;
  userEntryId: string;
  result: Promise<Readonly<PiProductRunRecord>>;
}

interface PiChatRuntimeEventBase {
  productRunId: string;
  conversationId: string;
  piSessionId: string;
  activeLeafId: string | null;
  occurredAt: number;
}

export type PiChatRuntimeEvent =
  | (PiChatRuntimeEventBase & {
      type: "reasoning_summary";
      summary: Readonly<EchoInkReasoningSummarySnapshot>;
    })
  | (PiChatRuntimeEventBase & {
      type: "provider_reasoning_start";
      messageKey: string;
      reasoningId: string;
    })
  | (PiChatRuntimeEventBase & {
      type: "provider_reasoning_delta";
      messageKey: string;
      reasoningId: string;
      textDelta: string;
    })
  | (PiChatRuntimeEventBase & {
      type: "provider_reasoning_end";
      messageKey: string;
      reasoningId: string;
      text: string;
      status: "completed" | "failed" | "cancelled" | "interrupted";
    })
  | (PiChatRuntimeEventBase & {
      type: "interaction_requested";
      interaction: Readonly<EchoInkTurnInteraction>;
    })
  | (PiChatRuntimeEventBase & {
      type: "interaction_resolved";
      record: Readonly<EchoInkTurnInteractionRecord>;
    })
  | (PiChatRuntimeEventBase & {
      type: "knowledge_progress";
      status: "active" | "completed";
      stage:
        | "searching"
        | "continuing_search"
        | "reading_knowledge"
        | "comparing_memory"
        | "checking_conflicts_freshness"
        | "refining_knowledge"
        | "writing_and_readback";
    })
  | (PiChatRuntimeEventBase & {
      type: "memory_recall_progress";
      status: "active" | "completed";
      stage: "loading" | "catalog" | "matching" | "budgeting" | "assembling";
      elapsedMs: number;
      recall?: PiMemoryRecallObservation;
    })
  | (PiChatRuntimeEventBase & {
      type: "message_start";
      messageKey: string;
      role: "user" | "assistant" | "tool";
    })
  | (PiChatRuntimeEventBase & {
      type: "message_update";
      messageKey: string;
      textDelta: string;
    })
  | (PiChatRuntimeEventBase & {
      type: "message_end";
      messageKey: string;
      entryId?: string;
      role: "user" | "assistant" | "tool";
      text: string;
      status?: "completed" | "failed" | "cancelled";
    })
  | (PiChatRuntimeEventBase & {
      type: "message_entry_resolved";
      messageKey: string;
      entryId: string;
    })
  | (PiChatRuntimeEventBase & {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: unknown;
      /** Set only by EchoInk Runtime; never inferred from model Tool args. */
      privacySafe?: boolean;
    })
  | (PiChatRuntimeEventBase & {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      update: unknown;
      privacySafe?: boolean;
    })
  | (PiChatRuntimeEventBase & {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
      privacySafe?: boolean;
    })
  | (PiChatRuntimeEventBase & {
      type: "compaction_start";
      reason: "manual" | "threshold" | "overflow";
    })
  | (PiChatRuntimeEventBase & {
      type: "compaction_end";
      reason: "manual" | "threshold" | "overflow";
      entryId?: string;
      aborted: boolean;
      willRetry: boolean;
      error?: string;
    })
  | (PiChatRuntimeEventBase & {
      type: "queue_update";
      steering: readonly string[];
      followUp: readonly string[];
    })
  | (PiChatRuntimeEventBase & {
      type: "agent_end";
      willRetry: boolean;
    })
  | (PiChatRuntimeEventBase & { type: "agent_settled" })
  | (PiChatRuntimeEventBase & {
      type: "branch_changed";
      previousLeafId: string | null;
    })
  | (PiChatRuntimeEventBase & {
      type: "diagnostic";
      diagnostic: PiConversationDiagnostic;
    })
  | (PiChatRuntimeEventBase & {
      type: "product_run_settled";
      terminalState: PiProductRunTerminalState;
      assistantEntryId?: string;
    });

export type PiChatRuntimeEventListener = (
  event: Readonly<PiChatRuntimeEvent>
) => void | Promise<void>;

export interface PiChatEventSubscription {
  unsubscribe(): void;
}

export interface PiConversationProjection {
  catalog: Readonly<PiConversationCatalogEntry>;
  activeLeafId: string | null;
  messages: ChatMessage[];
  diagnostics: PiConversationDiagnostic[];
  drafts: PiConversationDraftRecord[];
  /** Latest real Provider-request ledger on the current active Branch. */
  contextLedger?: Readonly<PiContextLedger>;
}

/**
 * Catalog-owned support state that remains readable when the Pi JSONL itself
 * is damaged. It contains no chat body or Tool transcript.
 */
export interface PiConversationSupportState {
  catalog: Readonly<PiConversationCatalogEntry>;
  diagnostics: PiConversationDiagnostic[];
  drafts: PiConversationDraftRecord[];
}

export interface PiBranchNavigationResult {
  activeLeafId: string | null;
  editorText?: string;
  cancelled: boolean;
}

/**
 * Result of deriving a new formal Conversation from a durable Pi prefix.
 * The source Session is never mutated; the projection belongs to the newly
 * cataloged Pi Session.
 */
export interface PiConversationDerivationResult {
  sourceConversationId: string;
  anchorEntryId: string;
  anchorRole: "user" | "assistant";
  editorText: string;
  /** Durable creation succeeded; activation may be retried independently. */
  activation:
    | Readonly<{ status: "activated" }>
    | Readonly<{ status: "failed"; message: string }>;
  projection: PiConversationProjection;
}
