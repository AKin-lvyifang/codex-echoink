import type { ChatMessage } from "../settings/settings";

export type WorkbenchResultType = "note" | "plan" | "answer";
/** Only the latest completed turn contributes evidence; earlier plans never leak forward. */
export function workbenchResultType(messages: readonly ChatMessage[], taskStartedAt = 0): WorkbenchResultType {
  const lastUser = messages.map(message => message.role).lastIndexOf("user");
  const latest = messages.slice(lastUser < 0 ? 0 : lastUser);
  const run = [...latest].reverse().find(message => message.runId)?.runId;
  const turn = run ? messages.filter(message => message.runId === run) : latest.filter(message => message.createdAt >= taskStartedAt);
  if (turn.some(message => message.role === "assistant" && message.savedNotePath)) return "note";
  if (turn.some(message => message.taskPlan && (!run || message.taskPlan.productRunId === run)
    && message.taskPlan.updatedAt >= taskStartedAt)) return "plan";
  return "answer";
}
