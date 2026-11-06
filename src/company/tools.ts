import { defineTool, type ToolDefinition, type ToolCallEvent, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { PiVaultAdditionalToolSecurityPort } from "../harness/pi-native/pi-vault-tool-security-extension";
import { COMPANY_ROUTER_TOOLS, COMPANY_WORKER_TOOLS } from "../agents/capability-core";
import { companyRouterToolSpecs, companyWorkerToolSpecs, type CompanyToolPort, type CompanyToolSpec } from "./tool-specs";

export type { CompanyToolPort } from "./tool-specs";

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });

/** Only the tool names in one set may pass; the capability policy decides who sees which set. */
export class CompanyToolSecurity implements PiVaultAdditionalToolSecurityPort {
  readonly toolName: string;
  readonly toolNames: readonly string[];
  constructor(names: readonly string[]) { this.toolName = names[0]; this.toolNames = names; }
  handleToolCall(event: ToolCallEvent): Promise<Readonly<{ block: true; reason: string }> | void> {
    return Promise.resolve(this.toolNames.includes(event.toolName) ? undefined : { block: true, reason: "tool_policy_blocked" });
  }
  handleToolResult(event: ToolResultEvent): Promise<Readonly<{ content: Array<{ type: "text"; text: string }>; details: Readonly<Record<string, unknown>>; isError: boolean }>> {
    const content = (Array.isArray(event.content) ? event.content : []).flatMap(item => item && typeof item === "object" && (item as { type?: unknown }).type === "text"
      ? [{ type: "text" as const, text: typeof (item as { text?: unknown }).text === "string" ? (item as { text: string }).text : "" }] : []);
    return Promise.resolve({ content, details: {}, isError: event.isError === true });
  }
}

const desktopTool = (spec: CompanyToolSpec): ToolDefinition => defineTool({ name: spec.name, label: spec.label, description: spec.description,
  executionMode: "sequential", parameters: spec.parameters, execute: async (_id, args) => text(await spec.run(args)) });
export function createCompanyRouterTools(port: CompanyToolPort, routerId: string): ToolDefinition[] { return companyRouterToolSpecs(port, routerId).map(desktopTool); }
export function createCompanyWorkerTools(port: CompanyToolPort, workerId: string): ToolDefinition[] { return companyWorkerToolSpecs(port, workerId).map(desktopTool); }
export const COMPANY_ROUTER_TOOL_NAMES = [...COMPANY_ROUTER_TOOLS];
export const COMPANY_WORKER_TOOL_NAMES = [...COMPANY_WORKER_TOOLS];
