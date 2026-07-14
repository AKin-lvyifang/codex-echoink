import type { AgentBackendDefinition } from "../../agent/registry";
import type { AgentCapabilities, CapabilityLevel } from "../contracts/capability";

export function legacyCapabilitySnapshotFromDefinition(definition: AgentBackendDefinition): AgentCapabilities {
  const capabilities = definition.capabilities;
  return {
    sessions: {
      resume: definition.kind === "codex-cli" ? "native" : "emulated",
      fork: "none"
    },
    output: {
      streaming: capabilities.richEvents ? "native" : "emulated",
      reasoningSummary: definition.kind !== "hermes" && capabilities.richEvents ? "native" : "none",
      thinkingTrace: definition.kind === "hermes" && capabilities.richEvents ? "native" : "none",
      planEvents: capabilities.richEvents ? "native" : "none",
      usage: definition.kind === "codex-cli" ? "native" : "emulated"
    },
    tools: {
      structuredCalls: level(capabilities.structuredToolCalls),
      nativeMcp: level(capabilities.nativeMcpPassThrough),
      nativeSkills: capabilities.listAgents ? "native" : "none",
      approvals: capabilities.nativeMcpPassThrough ? "native" : "emulated"
    },
    files: {
      read: capabilities.chat ? "emulated" : "none",
      write: capabilities.knowledgeTasks || capabilities.editorActions ? "emulated" : "none",
      diffEvents: level(capabilities.fileStatus)
    },
    input: {
      text: capabilities.chat ? "native" : "none",
      image: "emulated",
      pdf: "emulated"
    },
    cancellation: "emulated"
  };
}

function level(value: boolean): CapabilityLevel {
  return value ? "native" : "none";
}
