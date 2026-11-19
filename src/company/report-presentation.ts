import { parseReportMessage, type CompanyReportSnapshot } from "./logic";

export interface CompanyTranscriptMessage {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly companyProgrammatic?: boolean;
  readonly companyApproval?: boolean;
  /** Only a visible assistant answer can receive a source, never reasoning or tool events. */
  readonly isReply?: boolean;
}
export interface CompanyReportSource {
  readonly messageId: string;
  readonly report: CompanyReportSnapshot;
}
export interface CompanyReportProjection {
  readonly hidden: ReadonlySet<string>;
  readonly replies: ReadonlyMap<string, readonly CompanyReportSource[]>;
  readonly standalone: ReadonlyMap<string, readonly CompanyReportSource[]>;
}

/** Explicit company-only kinds; ordinary bracketed user text is never a filter rule. */
export function isCompanyProgrammaticUserMessage(message: Pick<CompanyTranscriptMessage, "role" | "text" | "companyProgrammatic" | "companyApproval">, companyRole?: string): boolean {
  if (companyRole !== "router" || message.role !== "user") return false;
  const text = message.text.trim();
  return !!message.companyProgrammatic || !!message.companyApproval || !!parseReportMessage(text)
    || text.startsWith("〔项目已取消〕") || text.startsWith("〔员工操作审批〕");
}

/** Presentation only. Keep the original messages, positions and model context untouched. */
export function projectCompanyReports(messages: readonly CompanyTranscriptMessage[], companyRole?: string): CompanyReportProjection {
  const hidden = new Set<string>(), replies = new Map<string, readonly CompanyReportSource[]>(), standalone = new Map<string, readonly CompanyReportSource[]>();
  let pending: CompanyReportSource[] = [];
  const unique = () => pending.filter((source, index) => pending.findIndex(item => item.report.taskId === source.report.taskId) === index);
  const leaveAtSource = () => {
    if (pending.length) standalone.set(pending[0].messageId, unique());
    pending = [];
  };
  for (const message of messages) {
    if (isCompanyProgrammaticUserMessage(message, companyRole)) {
      hidden.add(message.id);
      const report = parseReportMessage(message.text);
      if (report) pending.push({ messageId: message.id, report });
    } else if (message.role === "user") {
      // A stopped report must not acquire an unrelated reply to the next human request.
      leaveAtSource();
    } else if (message.role === "assistant" && message.isReply !== false && !message.companyApproval && message.text.trim() && pending.length) {
      replies.set(message.id, unique()); pending = [];
    }
  }
  leaveAtSource();
  return { hidden, replies, standalone };
}

export function companyReportSourceLabel(sources: readonly CompanyReportSource[], english = false): string {
  const failed = sources.filter(source => source.report.outcome === "failed").length;
  if (sources.length === 1) {
    const report = sources[0].report;
    return english ? `${report.agentName} ${failed ? "couldn't finish" : report.outcome === "need_decision" ? "needs your input" : "reported back"}`
      : `${report.agentName}${failed ? "没做成" : report.outcome === "need_decision" ? "等你定" : "交回"}`;
  }
  return english ? `${sources.length} reports${failed ? ` · ${failed} couldn't finish` : " returned"}`
    : failed ? `${sources.length} 份汇报 · ${failed} 份没做成` : `${sources.length} 份交回`;
}
