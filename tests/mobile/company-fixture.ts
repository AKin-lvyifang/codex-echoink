import { startMobileCompany } from "../../src/mobile/company-host";
import { emptyKnowledgeFolderBindings } from "../../src/knowledge-base/folder-bindings";
import { mobileModel } from "../../src/mobile/settings";
import { answer } from "./host.mjs";

/** Uses the production Runtime, CompanyService, Store and UI; only the Provider and Vault are fixtures. */
export async function installCompanyFixture(f: any): Promise<void> {
  f.settings.apiProviders = [{ id: "company-fixture", providerId: "custom", runtimeProviderId: "openai", apiProtocol: "openai-completions", authMode: "api-key", name: "受控测试模型", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-only", defaultModelId: "company-model", models: [{ ...mobileModel("company-model", { toolCalling: true }), displayName: "一人公司测试模型" }] }];
  f.settings.activeApiProviderId = "company-fixture"; f.settings.defaultModel = "company-model";
  f.settings.knowledgeBase.folderBindings ??= emptyKnowledgeFolderBindings();
  await f.host.app.vault.createFolder("项目");
  Object.assign(f.settings.knowledgeBase.folderBindings.roles.projects, { enabled: true, readPaths: ["项目"], writePath: "项目" });
  const snapshot = await f.services.agents.snapshot();
  await f.services.agents.update((registry: any) => {
    registry.agents.find((a: any) => a.id === "generalist").name = "研究员";
    registry.agents.push({ id: "writer", name: "文案", position: "写稿与交付", avatar: { kind: "preset", presetId: "aya" }, styleId: "execution", capabilityIds: ["knowledge", "note_create", "memory"] });
    registry.agents.find((a: any) => a.id === "sol").companyApprovalMode = "user";
    registry.moduleOwners.journal = "";
  }, snapshot.version);
  await f.store.update((state: any) => { state.permission = "workspace-write"; });
  let sequence = 0;
  const text = (message: any) => typeof message?.content === "string" ? message.content : (message?.content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
  f.runtime.request = async (raw: any) => {
    const body = JSON.parse(raw.body); f.requests.push(body);
    await new Promise(resolve => setTimeout(resolve, 180));
    const messages = body.messages, system = text(messages[0]), last = messages.at(-1), user = text([...messages].reverse().find((m: any) => m.role === "user"));
    const call = (name: string, args: unknown) => answer("openai-completions", "", [[`company-${++sequence}`, name, args]]);
    const project = f.plugin.company?.service.doc.projects.at(-1);
    if (system.includes("〔员工操作审批〕")) return last.role === "tool" ? answer("openai-completions", "判断完成。") : call("approval_decide", { decision: "approve", reason: "这是用户要求的项目交付文件" });
    if (system.includes("<echoink_company_worker")) {
      const toolCalls = messages.flatMap((m: any) => m.tool_calls ?? []);
      const lastTool = last.role === "tool" ? toolCalls.find((c: any) => c.id === last.tool_call_id)?.function?.name : undefined;
      const writer = system.includes("当前身份：文案"), path = `${project?.folder ?? "项目"}/${writer ? "介绍稿" : "资料摘要"}.md`;
      if (lastTool === "report_to_router") return answer("openai-completions", "已汇报。");
      if (lastTool === "note_create" && !/中断|stopped|interrupted/iu.test(text(last))) return call("report_to_router", { outcome: "done", summary: writer ? "介绍稿已保存" : "资料摘要已保存", outputs: [path] });
      if (!writer && lastTool !== "user_question" && !messages.some((m: any) => m.role === "tool" && text(m).includes('"answered":true'))) return call("user_question", { questions: [
        { questionId: "audience", prompt: "这篇介绍写给谁？", selection: "single", options: [{ optionId: "new", label: "新用户" }, { optionId: "old", label: "老用户" }], allowSupplement: true },
        { questionId: "focus", prompt: "介绍哪些重点？", selection: "multiple", options: [{ optionId: "dispatch", label: "总助派活" }, { optionId: "approval", label: "统一审批" }], allowSupplement: false }
      ] });
      return call("note_create", { path, content: writer ? "# 介绍稿\n\n总助派活，员工执行，用户在等你定处理问题与审批。" : "# 资料摘要\n\n读者为新用户，重点为总助派活和统一审批。" });
    }
    if (system.includes("<echoink_company_router")) {
      if (last.role === "tool") return answer("openai-completions", "已安排，进展会回到这张卡片。");
      if (user.startsWith("〔员工汇报〕")) {
        if (project && f.plugin.company.service.doc.dispatches.filter((d: any) => d.projectId === project.id).length === 2 && f.plugin.company.service.doc.dispatches.filter((d: any) => d.projectId === project.id).every((d: any) => d.status === "done")) return call("project_accept", { projectId: project.id, summary: "资料摘要和介绍稿均已交付。", results: project.criteria.map((criterion: string) => ({ criterion, passed: true, evidence: "对应文件已保存并完成审批" })) });
        return answer("openai-completions", "资料已交付，下一位员工接着做。");
      }
      if (user.includes("小活")) return call("task_dispatch", { agentId: "generalist", moduleId: "none", brief: "先确认这件小活的读者与重点" });
      if (user.includes("日记")) return call("task_dispatch", { moduleId: "journal", brief: "整理今天的日记" });
      if (user.includes("介绍") && !project) return call("project_propose", { name: "一人公司发布介绍", background: "给新用户说明移动端协作", goal: "交付资料摘要与介绍稿", criteria: ["资料摘要已保存", "介绍稿已保存"], roles: { generalist: "整理资料", writer: "写介绍稿" }, plan: [
        { id: "research", agentId: "generalist", moduleId: "none", label: "整理资料", brief: "整理介绍资料，先确认读者和重点", dependsOn: [], milestone: "资料摘要" },
        { id: "write", agentId: "writer", moduleId: "none", label: "写介绍稿", brief: "根据资料摘要写介绍稿", dependsOn: ["research"], milestone: "介绍稿" }
      ] });
      return answer("openai-completions", "原卡历史已保留，可以继续交代。");
    }
    return answer("openai-completions", "直接员工任务已完成。");
  };
  f.plugin.company = await startMobileCompany({ runtime: f.runtime, store: f.store, settings: () => f.settings, adapter: f.host.adapter,
    file: `plugin/mobile/devices/${f.store.instanceId}/company.v1.json`, folders: { projectRoot: async () => "项目", ensureFolder: path => f.host.app.vault.createFolder(path) },
    changed: () => { f.plugin.workbench?.invalidate(); f.runtime.onChange(); } });
  await f.plugin.saveSettings();
  f.company = f.plugin.company;
}
