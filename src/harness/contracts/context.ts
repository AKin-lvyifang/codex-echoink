export type ContextSectionChannel = "system" | "developer" | "user" | "tool" | "memory";

export const CONTEXT_COMPILE_MODES = ["bootstrap", "incremental", "catch-up", "workflow"] as const;

export type ContextCompileMode = typeof CONTEXT_COMPILE_MODES[number];

export interface ContextSection {
  id: string;
  priority: number;
  channel: ContextSectionChannel;
  content: string;
  source: string;
  maxTokens?: number;
  required: boolean;
  sensitive: boolean;
}

export interface ContextAttachment {
  type: "file" | "image" | "pdf";
  path: string;
  name?: string;
  mime?: string;
}

export interface SessionContextSnapshot {
  sessionId: string;
  contextId?: string;
  generation?: number;
  version: string;
  goal: string;
  currentState: string;
  decisions: string[];
  constraints: string[];
  openLoops: string[];
  keyReferences: string[];
  rollingSummary: string;
  summarizedFromMessageId?: string;
  summarizedThroughMessageId?: string;
  sourceMessageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface ContextSyncCursor {
  syncedThroughMessageId?: string;
  syncedSessionRevision: number;
  sessionGeneration?: number;
  contextId?: string;
  workspaceFingerprint?: string;
  snapshotVersion?: string;
}

export interface ContextManifest {
  runId: string;
  sessionId: string;
  backendId: string;
  mode: ContextCompileMode;
  sections: Array<{
    id: string;
    source: string;
    includedChars: number;
    truncated: boolean;
  }>;
  compiledThroughMessageId?: string;
  sessionRevision: number;
  sessionGeneration?: number;
  contextId?: string;
  contextStartsAfterMessageId?: string;
  commitId?: string;
  workspaceFingerprint?: string;
  vaultProfileFingerprint?: string;
  snapshotVersion?: string;
  createdAt: number;
}

export interface ContextBundle {
  corePolicy: ContextSection[];
  workflowContract: ContextSection[];
  turnInstruction: ContextSection[];
  vaultProfile: ContextSection[];
  sessionContext: ContextSection[];
  memoryContext: ContextSection[];
  knowledgeEvidence: ContextSection[];
  echoInkSkills: ContextSection[];
  nativeResourceHints: ContextSection[];
  attachments: ContextAttachment[];
  manifest?: ContextManifest;
}

export function emptyContextBundle(): ContextBundle {
  return {
    corePolicy: [],
    workflowContract: [],
    turnInstruction: [],
    vaultProfile: [],
    sessionContext: [],
    memoryContext: [],
    knowledgeEvidence: [],
    echoInkSkills: [],
    nativeResourceHints: [],
    attachments: []
  };
}
