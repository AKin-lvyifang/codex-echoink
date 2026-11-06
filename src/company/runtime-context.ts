import { isExpertAgent } from "../agents/persona";
import { GENERAL_ASSISTANT_ID, type AgentDefinition } from "../agents/types";

export interface CompanyExpertRuntimeContext {
  readonly prompt: string;
  assertAvailable(): void;
}

/** Company instructions supplement the existing expert package, including its live guards. */
export function createCompanyRuntimeContext(input: Readonly<{
  prepareExpertRuntime?(agentId: string, conversationId: string, text: string): Promise<CompanyExpertRuntimeContext>;
}>) {
  let expertContext: CompanyExpertRuntimeContext | undefined;
  return {
    async prepare(request: Readonly<{
      agent: AgentDefinition | undefined;
      conversationId: string;
      text: string;
      companyPrompt: string;
    }>): Promise<string> {
      expertContext = undefined;
      if (!isExpertAgent(request.agent)) return request.companyPrompt;
      if (!input.prepareExpertRuntime) throw new Error("专家服务尚未就绪。");
      const prepared = await input.prepareExpertRuntime(request.agent.id, request.conversationId, request.text);
      prepared.assertAvailable();
      expertContext = prepared;
      return [request.companyPrompt, prepared.prompt].filter(Boolean).join("\n\n");
    },
    assertAvailable(): void { expertContext?.assertAvailable(); }
  };
}

/** A trusted per-turn flag keeps employee history out of programmatic reports and approvals. */
export function companyHumanTurnBackground(input: Readonly<{
  agentId: string;
  companyRole?: "router" | "worker";
  companyProgrammatic: boolean;
  background(): string;
}>): string {
  return input.agentId === GENERAL_ASSISTANT_ID && input.companyRole === "router" && !input.companyProgrammatic ? input.background() : "";
}
