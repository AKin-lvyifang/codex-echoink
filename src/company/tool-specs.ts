import { AGENT_MODULE_IDS, type AgentModuleId } from "../agents/types";
import { Type, type TSchema } from "typebox";
import type { CompanyPlanTask, CompanyReport } from "./types";

/** What the tools need from the plugin. Every call names the card it comes from. */
export interface CompanyToolPort {
  roster(): string;
  dispatch(routerId: string, input: Readonly<{ agentId?: string; brief: string; title?: string; moduleId?: AgentModuleId | "none" }>): Promise<string>;
  message(routerId: string, taskId: string, text: string): Promise<string>;
  stop(routerId: string, taskId: string): Promise<string>;
  status(routerId: string, taskId?: string): string;
  propose(routerId: string, input: Readonly<{ name: string; background: string; goal: string; criteria: readonly string[]; dueLabel?: string;
    roles: Readonly<Record<string, string>>; plan: readonly CompanyPlanTask[] }>): Promise<string>;
  accept(routerId: string, projectId: string, results: readonly Readonly<{ criterion: string; passed: boolean; evidence: string; agentId?: string }>[], summary: string): Promise<string>;
  report(workerId: string, report: Omit<CompanyReport, "at" | "fallback">): Promise<string>;
}

/** One tool, independent of the desktop Pi SDK and the mobile Agent wrapper. */
export interface CompanyToolSpec {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  run(args: unknown): Promise<string>;
}

/** Each runtime has validated the arguments against the schema; this only names their shape. */
function shaped<T>(args: unknown): T { return args as T; }
const moduleSchema = () => Type.Union([...AGENT_MODULE_IDS.map(id => Type.Literal(id)), Type.Literal("none")]);
const s = (max: number, min = 1) => Type.String({ minLength: min, maxLength: max });

export function companyRouterToolSpecs(port: CompanyToolPort, routerId: string): CompanyToolSpec[] {
  return [
    { name: "company_roster", label: "查员工名单",
      description: "列出公司里的员工：编号、名字、负责什么。派活前先看名单，选最合适的人；名单包含七个模块的负责人和未指定状态。模块活必须交模块负责人；未指定时先指定。只有不属于模块的杂活交给通才。",
      parameters: Type.Object({}, { additionalProperties: false }),
      run: () => Promise.resolve(port.roster()) },
    { name: "task_dispatch", label: "派活",
      description: "把一件活派给一位员工，员工在自己的独立对话里做。立刻返回“已派出”和任务编号，不等做完；做完后员工的汇报会自动回到这张卡片。moduleId 必须说明任务属于哪个模块；只有不属于任何模块的杂活填 none。未指定模块负责人时也必须调用本工具，agentId 可以不填；程序只展示指定入口，不创建任务。brief 写清要做什么、交付什么，一两句话。",
      parameters: Type.Object({ agentId: Type.Optional(s(128)), moduleId: moduleSchema(), brief: s(1000), title: Type.Optional(s(64)) }, { additionalProperties: false }),
      run: args => port.dispatch(routerId, shaped<{ agentId?: string; brief: string; title?: string; moduleId?: AgentModuleId | "none" }>(args)) },
    { name: "task_message", label: "给员工带话",
      description: "给一件已派出的活补充要求或转达用户的回答。员工正在做时作为插话送到，做完当前一步就看到；已停下时会接着做。",
      parameters: Type.Object({ taskId: s(256), text: s(2000) }, { additionalProperties: false }),
      run: args => { const a = shaped<{ taskId: string; text: string }>(args); return port.message(routerId, a.taskId, a.text); } },
    { name: "task_stop", label: "停活",
      description: "停掉一件已派出的活。",
      parameters: Type.Object({ taskId: s(256) }, { additionalProperties: false }),
      run: args => port.stop(routerId, shaped<{ taskId: string }>(args).taskId) },
    { name: "task_status", label: "查进度",
      description: "查这张卡片派出的活和项目的进度。不传 taskId 时列出全部；传了就看这一件的汇报。",
      parameters: Type.Object({ taskId: Type.Optional(s(256)) }, { additionalProperties: false }),
      run: args => Promise.resolve(port.status(routerId, shaped<{ taskId?: string }>(args).taskId)) },
    { name: "project_propose", label: "出开工卡",
      description: "大事（要几位员工配合、有几份产出、分几天推进）先出开工卡，不直接开工。plan 是 3–6 件粗粒度的活：每件一位员工、一句话 brief、依赖哪几件（dependsOn 填 plan 里的 id）、可选 milestone 把几件归成一个里程碑节点。criteria 是 2–4 条可核对的验收标准。返回后等待用户点击开工卡的“开工 / 先不开”，不要另用 user_question 询问。",
      parameters: Type.Object({
        name: s(80), background: s(600), goal: s(300), dueLabel: Type.Optional(s(40)),
        criteria: Type.Array(s(120), { minItems: 1, maxItems: 6 }),
        roles: Type.Record(Type.String(), s(60)),
        plan: Type.Array(Type.Object({ id: s(32), agentId: s(128), moduleId: moduleSchema(), label: s(20), brief: s(600), dependsOn: Type.Array(s(32), { maxItems: 8 }), milestone: Type.Optional(s(30)) },
          { additionalProperties: false }), { minItems: 1, maxItems: 8 })
      }, { additionalProperties: false }),
      run: args => port.propose(routerId, shaped<Parameters<CompanyToolPort["propose"]>[1]>(args)) },
    { name: "project_accept", label: "验收结项",
      description: "所有活做完后，按开工时定的验收标准逐条核对并结项。每条写是否通过和依据（一句话）；summary 是给用户的结项小结，不超过 100 字。",
      parameters: Type.Object({ projectId: s(128), summary: s(300),
        results: Type.Array(Type.Object({ criterion: s(120), passed: Type.Boolean(), evidence: s(200), agentId: Type.Optional(s(128)) }, { additionalProperties: false }), { minItems: 1, maxItems: 6 })
      }, { additionalProperties: false }),
      run: args => { const a = shaped<{ projectId: string; summary: string; results: Parameters<CompanyToolPort["accept"]>[2] }>(args); return port.accept(routerId, a.projectId, a.results, a.summary); } }
  ];
}

export function companyWorkerToolSpecs(port: CompanyToolPort, workerId: string): CompanyToolSpec[] {
  return [{ name: "report_to_router", label: "向总助汇报",
    description: "这件活做完、做不成、或需要用户拿主意时，向总助汇报一次，然后结束这一轮。summary 一两句话写结论，不写过程；outputs 填写入库里的文件路径；需要用户定时 outcome 填 need_decision，并给 question 和 2–3 个 options。",
    parameters: Type.Object({ outcome: Type.Union([Type.Literal("done"), Type.Literal("need_decision"), Type.Literal("failed")]), summary: s(400),
      outputs: Type.Optional(Type.Array(s(400), { maxItems: 20 })), question: Type.Optional(s(600)), options: Type.Optional(Type.Array(s(60), { maxItems: 4 })) }, { additionalProperties: false }),
    run: args => { const a = shaped<{ outcome: CompanyReport["outcome"]; summary: string; outputs?: string[]; question?: string; options?: string[] }>(args);
      return port.report(workerId, { outcome: a.outcome, summary: a.summary, outputs: a.outputs ?? [], ...(a.question ? { question: a.question } : {}), ...(a.options?.length ? { options: a.options } : {}) }); } }];
}
