import type { AgentModuleId } from "../agents/types";

/** 模块页标题栏的负责人动作：桌面与手机共用同一份按钮文字和预填。 */
export type ModuleOwnerActionId = Exclude<AgentModuleId, "review">;
export interface ModuleOwnerActionContext { english: boolean; month?: string; pdfName?: string }

const pad = (value: number) => String(value).padStart(2, "0");
export const currentModuleMonth = (date = new Date()): string => `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
const monthNumber = (month: string): number => Number(month.slice(5, 7)) || new Date().getMonth() + 1;
const englishMonth = (month: string): string => new Intl.DateTimeFormat("en", { month: "long" }).format(new Date(2000, monthNumber(month) - 1, 1));

export function moduleOwnerActionLabel(moduleId: ModuleOwnerActionId, context: ModuleOwnerActionContext): string {
  const { english } = context, month = context.month ?? currentModuleMonth();
  switch (moduleId) {
    case "journal": return english ? "Review today" : "回顾今日";
    case "todos": return english ? "Plan to-dos" : "规划待办";
    case "finance": return english ? `Analyze ${englishMonth(month)} finances` : `分析 ${monthNumber(month)} 月收支`;
    case "knowledge-base": return english ? "Organize Inbox" : "整理 Inbox";
    case "english-diary": return english ? "Review this week's expressions" : "复习本周表达";
    case "pdf-reading": return english ? "Continue reading" : "继续精读";
  }
}

export function moduleOwnerActionPrompt(moduleId: ModuleOwnerActionId, context: ModuleOwnerActionContext): string {
  const { english } = context, month = context.month ?? currentModuleMonth();
  switch (moduleId) {
    case "journal": return english ? "Review today and turn it into a journal entry." : "回顾今日并整理成日记";
    case "todos": return english ? "Plan my to-dos for today and this week." : "规划今日与本周待办";
    case "finance": return english ? `Analyze income, spending and budget performance for ${month}.` : `分析 ${month} 的收支与预算执行情况`;
    case "knowledge-base": return english ? "Organize the pending items in Inbox." : "整理 Inbox 中的待处理内容";
    case "english-diary": return english ? "Review the English expressions saved this week." : "复习本周收录的英文表达";
    case "pdf-reading": return context.pdfName
      ? english ? `Continue the close reading of "${context.pdfName}", building on its saved outputs.` : `继续精读《${context.pdfName}》，沿用已保存的成果`
      : english ? "Continue the unfinished close reading, building on its saved outputs." : "继续精读未完成的 PDF，沿用已保存的成果";
  }
}
