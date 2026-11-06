import { getModuleOwner } from "../agents/registry";
import { CompanyApprovalCoordinator, type CompanyApprovalTicket } from "../company/approval-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { agentPositionDescription } from "../agents/identity";
import { isAgentHired } from "../agents/persona";
import { GENERAL_ASSISTANT_ID } from "../agents/types";
import { companyRouterPrompt, companyWorkerPrompt } from "../company/prompts";
import { CompanyService, type CompanyHost, type CompanyPermission } from "../company/service";
import { companyRouterToolSpecs, companyWorkerToolSpecs } from "../company/tool-specs";
import { MobileCompanyStore } from "./company-store";
import type { MobileCompanyRuntimePort, MobileRuntime, MobileTurnOutcome } from "./runtime";
import type { MobileSettings } from "./settings";
import { newSession, type MobilePermission, type MobileSession, type MobileStorageAdapter, type MobileStore } from "./store";

export interface MobileCompanyFolderPort {
  /** Returns a writable project root, asking once when none is bound; null cancels the start. */
  projectRoot(): Promise<string | null>;
  /** Creates `${root}/${name}` when missing and returns it. */
  ensureFolder(path: string): Promise<void>;
}

export interface MobileCompanyHostInput {
  readonly runtime: MobileRuntime;
  readonly store: MobileStore;
  readonly settings: () => MobileSettings;
  readonly folders: MobileCompanyFolderPort;
  /** Refresh surfaces and mark the router card unread, without a model turn. */
  readonly changed: (routerId?: string) => void;
}

const toCompany = (permission: MobilePermission): CompanyPermission => permission === "full-access" ? "danger-full-access" : permission;
const toMobile = (permission: CompanyPermission): MobilePermission => permission === "danger-full-access" ? "full-access" : permission;
const narrower = (a: MobilePermission, b: MobilePermission): MobilePermission => a === "read-only" || b === "read-only" ? "read-only" : a === "workspace-write" || b === "workspace-write" ? "workspace-write" : "full-access";
function text(message: AgentMessage | undefined): string {
  if (!message || !("content" in message)) return "";
  const content = message.content as string | readonly { type: string; text?: string }[];
  return typeof content === "string" ? content : content.flatMap(part => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
}

/** Same draft-first ceiling as the visible mobile Composer. */
export function mobileCompanyPermission(store: MobileStore, id: string): MobilePermission {
  const task = store.getSession(id), draft = task?.draftContext;
  const permission = draft?.selectedMode === "plan" ? "read-only" : draft?.selectedPermission === "danger-full-access" ? "full-access" : draft?.selectedPermission ?? task?.runs?.at(-1)?.permission ?? store.permission;
  return narrower(permission, store.permission);
}

/** CompanyService on the mobile runtime: workers are ordinary device-local tasks with companyRole "worker". */
export function createMobileCompanyHost(input: MobileCompanyHostInput): CompanyHost {
  const { runtime, store } = input;
  const session = (id: string) => store.getSession(id);
  return {
    now: () => Date.now(),
    newId: prefix => `${prefix}-${crypto.randomUUID()}`,
    agents: () => input.settings().agentRegistry.agents.map(agent => ({ id: agent.id, name: agent.name, position: agentPositionDescription(agent), hired: isAgentHired(agent) })),
    moduleOwner: module => getModuleOwner(input.settings().agentRegistry, module)?.id ?? null,
    routerPermission: routerId => toCompany(mobileCompanyPermission(store, routerId)),
    createWorker: async worker => {
      if (session(worker.id)) return;
      await store.update(state => {
        if (state.sessions.some(item => item.id === worker.id)) return;
        state.sessions.unshift({ ...newSession(worker.agentId), id: worker.id, title: worker.title, companyRole: "worker", ...(worker.projectId ? { projectId: worker.projectId } : {}) });
      });
    },
    startTurn: async (id, message, permission) => {
      try {
        const submission = await runtime.submitCompanyTurn(id, message, toMobile(permission));
        void submission.completion.catch(() => { /* The settled event reports the outcome. */ });
      } catch (error) {
        if ((error as { code?: string }).code === "mobile_resume_review_required") { input.changed(id); return "waiting"; }
        throw error;
      }
    },
    isRunning: id => runtime.isRunning(id),
    resumeReviewed: async (id, fingerprint, permission) => {
      const submission = await runtime.submitCompanyTurn(id, "请基于已核实的当前事实继续原任务，禁止重放旧写入。", toMobile(permission), { confirmationFingerprint: fingerprint });
      void submission.completion.catch(() => {});
    },
    steer: async (id, message) => {
      const interaction = session(id)?.interaction;
      if (interaction?.status !== "pending") return false;
      if (interaction.kind === "confirmation") throw new Error("操作审批请在“等你定”中批准或拒绝。");
      const answers = interaction.questions.map(question => {
        const selected = question.options.filter(option => message.includes(option.label) || message.trim() === option.optionId);
        if (question.selection === "single" && selected.length > 1 || !selected.length && !question.allowSupplement) throw new Error("请在“等你定”中完成这组问题。");
        return { questionId: question.questionId, selectedOptionIds: selected.map(option => option.optionId), ...(question.allowSupplement ? { supplement: message } : {}) };
      });
      await runtime.answerQuestion(id, interaction.runId, interaction.questionId, answers);
      return true;
    },
    stop: id => runtime.stopTask(id),
    lastAssistantText: id => Promise.resolve(text([...session(id)?.messages ?? []].reverse().find(message => message.role === "assistant" && text(message).trim())) || undefined),
    latestUserText: id => Promise.resolve(text([...session(id)?.messages ?? []].reverse().find(message => message.role === "user" && text(message).trim() && !text(message).startsWith("〔员工汇报〕"))) || undefined),
    setRouterMetadata: async (id, patch) => { await store.patchSession(id, patch); input.changed(id); },
    ensureFolder: async (name, routerId) => {
      const writable = () => { if (mobileCompanyPermission(store, routerId) === "read-only") throw new Error("这张卡片是只读权限，切换为可写后再开工。"); };
      writable();
      const root = await input.folders.projectRoot();
      if (root === null) return null;
      writable();
      const folder = `${root.replace(/\/+$/u, "")}/${name}`;
      await input.folders.ensureFolder(folder);
      return folder;
    },
    notifyDecision: async routerId => {
      await store.patchSession(routerId, { unreadAnswerAt: Date.now() });
      input.changed(routerId);
    }
  };
}

export interface MobileCompany {
  readonly service: CompanyService;
  readonly approvals: CompanyApprovalCoordinator;
  dispose(): void;
}

/** One service per device. Failure leaves the classic mobile assistant intact. */
export async function startMobileCompany(input: MobileCompanyHostInput & Readonly<{ adapter: MobileStorageAdapter; file: string }>): Promise<MobileCompany | null> {
  let unsubscribe: (() => void) | undefined;
  try {
    const host = createMobileCompanyHost(input);
    const service = new CompanyService(new MobileCompanyStore(input.adapter, input.file), host);
    const approvalRuns = new Set<string>();
    const tickets = (): CompanyApprovalTicket[] => service.doc.dispatches.flatMap(dispatch => {
      const task = input.store.getSession(dispatch.id), interaction = task?.interaction;
      if (dispatch.status !== "running" || interaction?.kind !== "confirmation" || interaction.status !== "pending" || !input.runtime.isBusy(dispatch.id)) return [];
      const question = interaction.questions[0];
      if (!question?.options.some(option => option.optionId === "approve") || !question.options.some(option => option.optionId === "deny")) return [];
      return [{ key: `${dispatch.id}:${interaction.runId}:${interaction.questionId}`, dispatch, binding: {
        target: interaction.approval?.target ?? question.prompt, preview: interaction.approval?.preview ?? question.prompt,
        deleteAction: interaction.approval?.deleteAction ?? /delete|remove|删除|移除/iu.test(question.prompt),
        decide: async decision => { await input.runtime.answerQuestion(dispatch.id, interaction.runId, interaction.questionId,
          [{ questionId: question.questionId, selectedOptionIds: [decision === "approve" ? "approve" : "deny"] }]); return true; }
      } }];
    });
    const approvals = new CompanyApprovalCoordinator({ tickets,
      canJudge: ticket => input.settings().agentRegistry.agents.find(agent => agent.id === GENERAL_ASSISTANT_ID)?.companyApprovalMode === "assistant"
        && input.store.getSession(ticket.dispatch.routerConversationId)?.companyRole === "router"
        && mobileCompanyPermission(input.store, ticket.dispatch.routerConversationId) !== "read-only" && input.store.permission !== "read-only",
      isRunning: id => input.runtime.isRunning(id),
      run: async (id, key, message) => {
        approvalRuns.add(id);
        try { const submission = await input.runtime.submitCompanyTurn(id, message, mobileCompanyPermission(input.store, id), { approvalKey: key }); await submission.completion; }
        finally { approvalRuns.delete(id); await service.flushPendingReports(); }
      },
      record: (id, decision, reason) => service.recordApprovalDecision(id, decision, reason),
      subscribe: listener => { const offRuntime = input.runtime.subscribe(listener), offCompany = service.subscribe(listener); return () => { offRuntime(); offCompany(); }; },
      changed: id => input.changed(id)
    });
    host.canReceiveReports = id => !approvalRuns.has(id) && !approvals.hasPendingJudgment(id);
    const port: MobileCompanyRuntimePort = {
      adoptsRouter: task => task.agentId === GENERAL_ASSISTANT_ID && !task.companyRole && !task.businessKey && !task.draftContext?.prefillSource,
      prompt: (task, programmatic, approvalKey) => {
        if (approvalKey) return approvals.judgmentPrompt(task.id, approvalKey) ?? "审批已失效，请结束。";
        if (task.companyRole === "router") {
          const project = service.projectForRouter(task.id);
          return [companyRouterPrompt(project?.status === "proposed" ? undefined : project, service.status(task.id)), programmatic ? "" : service.staffActivityBackground()].filter(Boolean).join("\n");
        }
        const dispatch = service.dispatchOf(task.id);
        return task.companyRole === "worker" && dispatch ? companyWorkerPrompt(dispatch.projectId ? service.projectOf(dispatch.projectId) : undefined) : "";
      },
      isJudging: key => approvals.isJudging(key),
      tools: (task, approvalKey) => approvalKey ? [approvals.decisionSpec(task.id, approvalKey)].filter((spec): spec is NonNullable<typeof spec> => !!spec) : task.companyRole === "router" && task.agentId === GENERAL_ASSISTANT_ID ? companyRouterToolSpecs(service, task.id)
        : task.companyRole === "worker" && service.dispatchOf(task.id) ? companyWorkerToolSpecs(service, task.id) : []
    };
    input.runtime.setCompany(() => port);
    unsubscribe = input.runtime.onTurnSettled((id, outcome, startedAt) => { void settle(service, input, id, outcome, startedAt); });
    await service.initialize();
    const stopChanges = service.subscribe(() => input.changed());
    approvals.start();
    return { service, approvals, dispose: () => { approvals.dispose(); unsubscribe?.(); stopChanges(); input.runtime.setCompany(() => undefined); } };
  } catch (error) {
    unsubscribe?.(); input.runtime.setCompany(() => undefined);
    console.error("EchoInk mobile company unavailable", error);
    return null;
  }
}

async function settle(service: CompanyService, input: MobileCompanyHostInput, id: string, outcome: MobileTurnOutcome, startedAt: number): Promise<void> {
  try {
    const task: MobileSession | undefined = input.store.getSession(id);
    if (task?.companyRole === "router") { await service.flushPendingReports(); return; }
    // Leaving the foreground is not a result: the dispatch stays running and resumes when the app returns.
    if (outcome === "completed" && task && !task.companyRole && task.agentId !== GENERAL_ASSISTANT_ID && !service.dispatchOf(id)) {
      const run = task.runs?.find(run => run.startedAt === startedAt);
      await service.recordStaffActivity({ conversationId: id, piSessionId: id, turnId: run?.id ?? `${startedAt}`, agentId: task.agentId,
        title: text([...task.messages].reverse().find(message => message.role === "user")) || task.title,
        summary: text([...task.messages].reverse().find(message => message.role === "assistant")) || "任务已完成。", at: Date.now() });
    }
    if (outcome === "suspended" || task?.companyRole !== "worker" || !service.dispatchOf(id)) return;
    await service.onWorkerSettled(id, outcome === "completed" ? "completed" : outcome === "cancelled" ? "interrupted" : "failed", startedAt);
  } catch (error) { console.error("EchoInk mobile company report failed", error); }
}
