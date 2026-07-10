import type { AgentBackendCapabilities, AgentBackendKind } from "./types";

export type CapabilityBackendChoice = "default" | AgentBackendKind;

export interface AgentBackendDefinition {
  kind: AgentBackendKind;
  label: string;
  description: string;
  capabilities: AgentBackendCapabilities;
}

export const AGENT_BACKEND_DEFINITIONS: AgentBackendDefinition[] = [
  {
    kind: "codex-cli",
    label: "Codex",
    description: "Codex CLI app-server backend",
    capabilities: {
      chat: true,
      knowledgeTasks: true,
      editorActions: true,
      listModels: true,
      listAgents: false,
      fileStatus: false,
      richEvents: false,
      structuredToolCalls: false,
      nativeMcpPassThrough: true,
      promptInstructionInjection: true,
      customProviderConfig: "codex-responses"
    }
  },
  {
    kind: "opencode",
    label: "OpenCode",
    description: "OpenCode server API backend",
    capabilities: {
      chat: true,
      knowledgeTasks: true,
      editorActions: true,
      listModels: true,
      listAgents: true,
      fileStatus: true,
      richEvents: false,
      structuredToolCalls: false,
      nativeMcpPassThrough: false,
      promptInstructionInjection: true,
      customProviderConfig: "opencode-provider"
    }
  },
  {
    kind: "hermes",
    label: "Hermes",
    description: "Hermes API server or CLI fallback backend",
    capabilities: {
      chat: true,
      knowledgeTasks: true,
      editorActions: true,
      listModels: true,
      listAgents: true,
      fileStatus: false,
      richEvents: true,
      structuredToolCalls: false,
      nativeMcpPassThrough: false,
      promptInstructionInjection: true,
      customProviderConfig: "hermes-model"
    }
  }
];

export function getAgentBackendDefinition(kind: AgentBackendKind): AgentBackendDefinition {
  return AGENT_BACKEND_DEFINITIONS.find((definition) => definition.kind === kind) ?? AGENT_BACKEND_DEFINITIONS[0];
}

export function agentBackendDisplayName(kind: AgentBackendKind): string {
  return getAgentBackendDefinition(kind).label;
}

export function isAgentBackendKind(value: unknown): value is AgentBackendKind {
  return value === "codex-cli" || value === "opencode" || value === "hermes";
}

export function resolveCapabilityBackend(choice: CapabilityBackendChoice, defaultBackend: AgentBackendKind): AgentBackendKind {
  return choice === "default" ? defaultBackend : choice;
}
