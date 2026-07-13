import type { AgentAdapter } from "./adapter";

export interface AdapterConformanceIssue {
  code: string;
  message: string;
}

export function validateAdapterManifest(adapter: AgentAdapter): AdapterConformanceIssue[] {
  const issues: AdapterConformanceIssue[] = [];
  if (!adapter.manifest.id.trim()) issues.push({ code: "manifest.id", message: "Adapter manifest id is required." });
  if (!adapter.manifest.displayName.trim()) issues.push({ code: "manifest.displayName", message: "Adapter display name is required." });
  if (!adapter.manifest.version.trim()) issues.push({ code: "manifest.version", message: "Adapter version is required." });
  return issues;
}
