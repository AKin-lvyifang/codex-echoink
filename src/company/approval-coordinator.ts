import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { GENERAL_ASSISTANT_ID } from "../agents/types";
import type CodexForObsidianPlugin from "../main";
import { newId } from "../settings/settings";
import { companyApprovals } from "./interaction-bridge";
import { companyRouterPermission } from "./folder-bridge";

import { CompanyApprovalCoordinator as ApprovalCore } from "./approval-core";
export type { CompanyApprovalDecision, CompanyApprovalTicket, CompanyApprovalHost } from "./approval-core";

export class CompanyApprovalCoordinator extends ApprovalCore {
  decisionTool(routerId: string, key: string): ToolDefinition | undefined {
    const spec = this.decisionSpec(routerId, key);
    return spec ? defineTool({ name: spec.name, label: spec.label, description: spec.description, parameters: spec.parameters, executionMode: "sequential",
      execute: async (_id, args) => ({ content: [{ type: "text" as const, text: await spec.run(args) }], details: {} }) }) : undefined;
  }
}

export function createCompanyApprovalCoordinator(plugin: CodexForObsidianPlugin): CompanyApprovalCoordinator {
  const runs = plugin.getConversationRunService();
  const routerAccess = (routerId: string) => ({ permission: companyRouterPermission(plugin, routerId),
    mode: plugin.getCodexView()?.companyCardAccess(routerId).mode
      ?? plugin.settings.taskWorkspace?.replyDrafts[routerId]?.selectedMode
      ?? runs.lastTurnOptions.get(routerId)?.mode ?? plugin.settings.defaultMode });
  return new CompanyApprovalCoordinator({
    tickets: () => plugin.companyService ? companyApprovals(plugin, plugin.companyService.doc, { includeJudging: true }) : [],
    canJudge: ticket => {
      const router = plugin.settings.sessions.find(session => session.id === ticket.dispatch.routerConversationId);
      const agent = plugin.settings.agentRegistry.agents.find(candidate => candidate.id === GENERAL_ASSISTANT_ID);
      const current = routerAccess(ticket.dispatch.routerConversationId);
      const worker = runs.lastTurnOptions.get(ticket.dispatch.id);
      return agent?.companyApprovalMode === "assistant" && router?.agentId === GENERAL_ASSISTANT_ID && router.companyRole === "router"
        && current.permission !== "read-only" && current.mode !== "plan"
        && worker?.permission !== "read-only" && worker?.mode !== "plan";
    },
    isRunning: id => runs.isTurnActive(id),
    run: async (routerId, key, text) => {
      const catalog = await plugin.readPiConversationCatalogEntry(routerId);
      if (catalog?.agentId !== GENERAL_ASSISTANT_ID || catalog.companyRole !== "router") throw new Error("company_approval_router_invalid");
      const options = runs.lastTurnOptions.get(routerId), current = routerAccess(routerId);
      const ticket = plugin.companyService ? companyApprovals(plugin, plugin.companyService.doc, { includeJudging: true }).find(item => item.key === key) : undefined;
      const worker = ticket ? runs.lastTurnOptions.get(ticket.dispatch.id) : undefined;
      if (!options || options.permission === "read-only" || options.mode === "plan"
        || !ticket || ticket.dispatch.routerConversationId !== routerId || ticket.binding.deleteAction
        || ticket.dispatch.permission === "read-only" || ticket.dispatch.turnPermission === "read-only"
        || worker?.permission === "read-only" || worker?.mode === "plan"
        || current.permission === "read-only" || current.mode === "plan") throw new Error("company_approval_router_unavailable");
      const ceilings = [options.permission, current.permission, ticket.dispatch.permission,
        ticket.dispatch.turnPermission ?? ticket.dispatch.permission, worker?.permission ?? ticket.dispatch.permission];
      const permission = ceilings.includes("workspace-write") ? "workspace-write" : "danger-full-access";
      return await runs.run({ id: newId("company-approval"), sessionId: routerId, text, attachments: [], skill: null,
        turnOptions: { ...options, permission, companyProgrammatic: true, companyApprovalKey: key }, kind: "chat", createdAt: Date.now() }, "composer");
    },
    record: async (id, decision, reason) => { await plugin.companyService?.recordApprovalDecision(id, decision, reason); },
    subscribe: listener => {
      const offRuns = runs.subscribe({ refresh: listener, clearAcceptedDraft() {}, isTaskVisible: () => false });
      const offSettled = runs.onTurnSettled(listener);
      const offCompany = plugin.companyService?.subscribe(listener);
      return () => { offRuns(); offSettled(); offCompany?.(); };
    },
    changed: id => { runs.refreshTask(id); plugin.notifyHomeSurfacesChanged(); }
  });
}
