import type { AgentModuleId } from "../agents/types";
/** One-person company: the general assistant routes work; other Agents do it. */
export type CompanyProjectStatus = "proposed" | "running" | "paused" | "done" | "cancelled";
export type CompanyDispatchStatus = "queued" | "running" | "waiting" | "done" | "failed" | "stopped";
export type CompanyReportOutcome = "done" | "need_decision" | "failed";
export type CompanyMilestoneState = "todo" | "current" | "waiting" | "done";

/** One planned piece of work. A milestone groups tasks; tasks without one form their own step. */
export interface CompanyPlanTask {
  readonly id: string;
  readonly agentId: string;
  readonly moduleId?: AgentModuleId | "none";
  /** Short label, for example "查资料". */
  readonly label: string;
  /** One-sentence brief sent to the Agent. */
  readonly brief: string;
  readonly dependsOn: readonly string[];
  readonly milestone?: string;
}

export interface CompanyAcceptance {
  readonly criterion: string;
  readonly passed: boolean;
  readonly evidence: string;
  readonly agentId?: string;
}

export interface CompanyProject {
  readonly id: string;
  readonly name: string;
  readonly background: string;
  readonly goal: string;
  readonly criteria: readonly string[];
  /** Vault-relative folder for outputs; created when the project starts. */
  readonly folder: string;
  /** The general assistant card bound to this project. */
  readonly routerConversationId: string;
  readonly status: CompanyProjectStatus;
  readonly plan: readonly CompanyPlanTask[];
  readonly roles: Readonly<Record<string, string>>;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly dueLabel?: string;
  readonly endedAt?: number;
  readonly acceptance?: readonly CompanyAcceptance[];
  readonly summary?: string;
}

export interface CompanyReport {
  readonly outcome: CompanyReportOutcome;
  readonly summary: string;
  readonly outputs: readonly string[];
  readonly question?: string;
  readonly options?: readonly string[];
  readonly at: number;
  /** True when the Agent forgot to report and the last reply was used. */
  readonly fallback?: boolean;
}

/** One dispatched task. id equals the worker Conversation id. */
export interface CompanyDispatch {
  readonly id: string;
  readonly routerConversationId: string;
  readonly projectId?: string;
  readonly planTaskId?: string;
  readonly agentId: string;
  readonly moduleId?: AgentModuleId | "none";
  readonly brief: string;
  readonly status: CompanyDispatchStatus;
  /** Permission inherited from the router card at dispatch time. */
  readonly permission: "read-only" | "workspace-write" | "danger-full-access";
  /** Permission used by the active turn; the dispatch permission remains its original ceiling. */
  readonly turnPermission?: CompanyDispatch["permission"];
  /** The dispatch is saved before creating its worker conversation. */
  readonly workerPending?: boolean;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly turns: number;
  readonly report?: CompanyReport;
  /** Durable outbox entry. Clear only the entry that was successfully delivered. */
  readonly reportPending?: { readonly id: string; readonly tail?: string };
  /** Answer given to a need_decision report, before it is sent back. */
  readonly answer?: string;
  /** First message for the next turn of a queued, already-started task. byPerson wakes may use one slot beyond the limit. */
  readonly wake?: { readonly text: string; readonly byPerson: boolean };
}

export type CompanyEventKind = "user" | "goal" | "dispatch" | "report" | "question" | "answer" | "rework" | "system" | "close";
/** The project "记录": the dispatch-and-report layer, in time order. */
export interface CompanyEvent {
  readonly id: string;
  readonly projectId: string;
  readonly kind: CompanyEventKind;
  /** Agent id, "me" for the user, or "system". */
  readonly who: string;
  readonly text: string;
  readonly files?: readonly string[];
  readonly at: number;
}

/** A completed task handed directly to an employee; this is background, never a dispatch. */
export interface CompanyStaffActivity {
  readonly conversationId: string;
  readonly piSessionId: string;
  readonly turnId: string;
  readonly agentId: string;
  /** Bounded original user request; conversation title is only a fallback for an empty request. */
  readonly title: string;
  readonly summary: string;
  readonly at: number;
}

export interface CompanyDocument {
  readonly schemaVersion: 1;
  readonly projects: readonly CompanyProject[];
  readonly dispatches: readonly CompanyDispatch[];
  readonly events: readonly CompanyEvent[];
  /** Optional in old schemaVersion 1 documents. Kept separately from company-dispatched work. */
  readonly staffActivities?: readonly CompanyStaffActivity[];
  readonly ownerRequests?: readonly CompanyOwnerRequest[];
}

export interface CompanyOwnerRequest {
  readonly projectId?: string;
  readonly planTaskId?: string;
  readonly dispatchId?: string;
  readonly id: string;
  readonly routerConversationId: string;
  readonly moduleId: AgentModuleId;
  readonly brief: string;
  readonly title?: string;
  readonly proposal?: Pick<CompanyProject, "name" | "goal" | "background" | "criteria" | "roles" | "plan" | "dueLabel">;
}

export interface CompanyMilestone {
  readonly title: string;
  readonly agentIds: readonly string[];
  readonly taskIds: readonly string[];
  readonly state: CompanyMilestoneState;
  readonly doneAt?: number;
  /** "《资料摘要》→ 文案" once handed off. */
  readonly handoff?: string;
}

export const COMPANY_MAX_RUNNING = 3;
/** One card may hold at most this many unfinished dispatches; stops a misbehaving model from fanning out without end. */
export const COMPANY_MAX_OPEN_PER_ROUTER = 8;
export const COMPANY_REPORT_SUMMARY_LIMIT = 400;

export const COMPANY_STAFF_ACTIVITY_LIMIT = 10;
export const COMPANY_STAFF_ACTIVITY_TITLE_LIMIT = 80;
export const COMPANY_STAFF_ACTIVITY_SUMMARY_LIMIT = 200;
