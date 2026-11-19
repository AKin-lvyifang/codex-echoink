import { pickErrorCopy } from "../core/error-copy";
import { agentCapabilityDenialCopy, parseAgentCapabilityDenial, PROVIDER_CODES } from "../core/error-copy/codes/provider";

/** User-facing copy shared by submission and resume checks; sentences live in core/error-copy/codes/provider.ts. */
export function agentCapabilityDenialText(reason: string, capability: string, language: string): string {
  return pickErrorCopy(agentCapabilityDenialCopy(reason, capability), language);
}

export class AgentCapabilityDeniedError extends Error {
  readonly code: string;
  constructor(readonly reason: string, readonly capabilityId: string, language?: string) {
    const code = `agent_capability_${reason}:${capabilityId}`;
    super(language ? agentCapabilityDenialText(reason, capabilityId, language) : code);
    this.code = code;
  }
}

export function knownAgentCapabilityDenial(error: unknown): { reason: string; capabilityId: string } | undefined {
  const value = error instanceof Error ? (error as Error & { code?: string }).code ?? error.message : typeof error === "string" ? error : "";
  return parseAgentCapabilityDenial(value);
}

export function agentCapabilityErrorText(error: unknown, language: string): string | undefined {
  const denial = knownAgentCapabilityDenial(error);
  if (denial) return agentCapabilityDenialText(denial.reason, denial.capabilityId, language);
  const message = error instanceof Error ? error.message : error;
  if (message === "agent_capability_knowledge_denied") return pickErrorCopy(PROVIDER_CODES.agent_capability_knowledge_denied, language);
}
