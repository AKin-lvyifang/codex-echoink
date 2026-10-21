import type { GenerationAttempt, GenerationRequest, GenerationResult } from "./types";
import type { GenerationSourceAssessment } from "./sources";
import type { PiWorkspaceAccess } from "../harness/pi-native/pi-workspace-access";
export interface GenerationExecutionIdentity {
  conversationId: string;
  piSessionId: string;
  productRunId: string;
  vaultId: string;
  access: PiWorkspaceAccess;
  signal: AbortSignal;
}
export type GenerationStage = "reading" | "writing" | "layout" | "approval" | "saving";
export interface GenerationRuntimePort {
  prepare(request: GenerationRequest, identity: GenerationExecutionIdentity): Promise<GenerationSourceAssessment>;
  /** Recheck live capabilities without reading or changing the frozen source snapshot. */
  assertContinuation?(request: GenerationRequest, identity: GenerationExecutionIdentity): Promise<void>;
  finish(request: GenerationRequest, assessment: GenerationSourceAssessment, modelText: string | null, identity: GenerationExecutionIdentity,
    onStage: (stage: GenerationStage) => Promise<void>, attempt?: GenerationAttempt): Promise<GenerationResult>;
}
