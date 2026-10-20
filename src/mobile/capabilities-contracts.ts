import type { EchoInkMcpDiscoveredTool, EchoInkMcpToolPolicy } from "../resources/types";
import type { TavilySettings, WebSearchResult } from "../tools/tavily-search";

export interface MobileSkillSummary {
  id: string; name: string; description: string; icon: string; builtin: boolean; enabled: boolean;
  mobileAvailable: boolean; unavailableReason?: string; contentPath: string | null; sourceLabel: string;
  agents: { id: string; name: string; allowed: boolean }[];
  usageCount?: number; lastUsedAt?: number | null;
}
export interface MobileSkillSnapshot extends MobileSkillSummary { content: string; version: string }
export type MobileMcpStatus = "missing" | "configured" | "connected" | "failed" | "desktop-only" | "credential-required";
export interface MobileMcpSummary {
  id: string; name: string; description: string; enabled: boolean; transport: "http" | "stdio";
  readonly: boolean; status: MobileMcpStatus; statusLabel: string; error?: string; trusted: boolean;
  tools: EchoInkMcpDiscoveredTool[]; toolPolicies: Record<string, EchoInkMcpToolPolicy>; version: string;
}
export interface MobileMcpDraft {
  id: string; name: string; description: string; enabled: boolean; transport: "http" | "stdio";
  readonly: boolean; url: string; headers: Record<string, string>; trusted: boolean;
  tools: EchoInkMcpDiscoveredTool[]; toolPolicies: Record<string, EchoInkMcpToolPolicy>; version: string;
  discoveredAt?: number; status?: MobileMcpStatus; error?: string;
}
export interface MobileTavilySnapshot extends TavilySettings { version: string }
export interface MobileCapabilitiesPort {
  listSkills(): Promise<MobileSkillSummary[]>;
  readSkill(id: string): Promise<MobileSkillSnapshot>;
  setSkillEnabled(id: string, enabled: boolean): Promise<MobileSkillSummary>;
  saveSkill(id: string, content: string, version: string): Promise<MobileSkillSnapshot>;
  defaultSkillContent(id: string): string | null;
  listMcp(): Promise<MobileMcpSummary[]>;
  createMcpDraft(id?: string): Promise<MobileMcpDraft>;
  discoverMcp(draft: MobileMcpDraft, signal?: AbortSignal): Promise<MobileMcpDraft>;
  saveMcp(draft: MobileMcpDraft): Promise<MobileMcpSummary>;
  setMcpEnabled(id: string, enabled: boolean): Promise<MobileMcpSummary>;
  readTavily(): MobileTavilySnapshot;
  saveTavily(draft: MobileTavilySnapshot): Promise<MobileTavilySnapshot>;
  testTavily(draft: MobileTavilySnapshot, signal?: AbortSignal): Promise<{ results: WebSearchResult[] }>;
}
