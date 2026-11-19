import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { MobileSession } from "../../mobile/store";
import { messageRunIds } from "../../mobile/task-recovery";
import { projectCompanyReports } from "../../company/report-presentation";

export function mobileCompanyMessageId(message: AgentMessage, index: number): string {
  return `message:${index}:${"timestamp" in message ? message.timestamp : ""}`;
}

export function mobileCompanyReportProjection(task: MobileSession) {
  const ids = messageRunIds(task), runs = new Map(task.runs?.map(run => [run.id, run]));
  return projectCompanyReports(task.messages.map((message, index) => {
    const run = runs.get(ids.get(index) ?? "");
    const content = "content" in message ? message.content : "";
    const text = typeof content === "string" ? content : content.filter(block => block.type === "text").map(block => block.text).join("\n");
    return { id: mobileCompanyMessageId(message, index), role: message.role, text,
      companyProgrammatic: run?.companyProgrammatic, companyApproval: run?.companyApproval };
  }), task.companyRole);
}
