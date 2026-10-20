import type { GenerationRequest, GenerationResult } from "./types";
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
  finish(request: GenerationRequest, assessment: GenerationSourceAssessment, modelText: string | null, identity: GenerationExecutionIdentity,
    onStage: (stage: GenerationStage) => Promise<void>): Promise<GenerationResult>;
}
