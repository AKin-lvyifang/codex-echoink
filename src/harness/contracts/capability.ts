export const CAPABILITY_LEVELS = ["none", "emulated", "native"] as const;

export type CapabilityLevel = typeof CAPABILITY_LEVELS[number];

export interface AgentCapabilities {
  sessions: {
    resume: CapabilityLevel;
    fork: CapabilityLevel;
  };
  output: {
    streaming: CapabilityLevel;
    reasoningSummary: CapabilityLevel;
    planEvents: CapabilityLevel;
    usage: CapabilityLevel;
  };
  tools: {
    structuredCalls: CapabilityLevel;
    nativeMcp: CapabilityLevel;
    nativeSkills: CapabilityLevel;
    approvals: CapabilityLevel;
  };
  files: {
    read: CapabilityLevel;
    write: CapabilityLevel;
    diffEvents: CapabilityLevel;
  };
  input: {
    text: CapabilityLevel;
    image: CapabilityLevel;
    pdf: CapabilityLevel;
  };
  cancellation: CapabilityLevel;
}

export function noCapabilities(): AgentCapabilities {
  return {
    sessions: { resume: "none", fork: "none" },
    output: { streaming: "none", reasoningSummary: "none", planEvents: "none", usage: "none" },
    tools: { structuredCalls: "none", nativeMcp: "none", nativeSkills: "none", approvals: "none" },
    files: { read: "none", write: "none", diffEvents: "none" },
    input: { text: "none", image: "none", pdf: "none" },
    cancellation: "none"
  };
}
