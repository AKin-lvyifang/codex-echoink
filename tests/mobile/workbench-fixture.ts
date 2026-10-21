import { mobileModel } from "../../src/mobile/settings";

/** Browser-only synthetic Provider. Tasks are admitted through the production runtime. */
export async function seedWorkbenchFixture(f: any): Promise<void> {
  f.settings.apiProviders = [{ id: "fixture", providerId: "deepseek", runtimeProviderId: "deepseek", apiProtocol: "openai-completions", authMode: "api-key", name: "DeepSeek（测试）", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-only", defaultModelId: "fixture-model", models: [{ ...mobileModel("fixture-model"), displayName: "DeepSeek 测试模型" }] }];
  f.settings.activeApiProviderId = "fixture"; f.settings.defaultModel = "fixture-model";
  await f.plugin.saveSettings();
  const snapshot = await f.services.agents.snapshot();
  await f.services.agents.update((registry: any) => {
    const agents = [["organizer", "整理员", "整理 Inbox、写 Wiki、补双链", "nova"], ["finance", "记账员", "整理账目与分类", "rio"], ["research", "研究员", "查资料、做对比", "lin"], ["journal", "日记陪伴", "记录今天", "aya"], ["review", "复盘", "回顾决定与行动", "han"]];
    for (const [id, name, position, presetId] of agents) if (!registry.agents.some((agent: any) => agent.id === id)) registry.agents.push({ id, name, position, avatar: { kind: "preset", presetId }, styleId: "execution", capabilityIds: ["knowledge", "todos", "memory", "note_create"] });
    registry.moduleOwners["knowledge-base"] = "organizer";
  }, snapshot.version);
  await f.services.refreshAgentIdentity();
  f.m6Requests = [];
  const answer = (text: string, calls: [string, object][] = []) => ({ status: 200, json: { id: `fixture-${f.m6Requests.length}`, model: "fixture-model", choices: [{ finish_reason: calls.length ? "tool_calls" : "stop", message: { role: "assistant", content: text || null, tool_calls: calls.map(([name, args], index) => ({ id: `call-${f.m6Requests.length}-${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } })) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } });
  f.runtime.request = async (request: any) => {
    const payload = JSON.parse(request.body); f.m6Requests.push(payload);
    const messages = payload.messages, index = messages.findLastIndex((message: any) => message.role === "user"), prompt = String(messages[index]?.content);
    if (prompt.includes("中断") || prompt.includes("进行")) return new Promise(() => {});
    if (prompt.includes("回应") && !messages.slice(index + 1).some((message: any) => message.role === "tool")) return answer("", [["user_question", { questions: [{ questionId: "write-choice", prompt: "这几条现在写入 Wiki 吗？", selection: "single", options: [{ optionId: "yes", label: "全部写入" }, { optionId: "no", label: "先不动" }], allowSupplement: false }] }]]);
    if (prompt.includes("多选") && !messages.slice(index + 1).some((message: any) => message.role === "tool")) return answer("", [["user_question", { questions: [{ questionId: "multi-choice", prompt: "选择要整理的测试资料", selection: "multiple", options: [{ optionId: "a", label: "测试资料甲" }, { optionId: "b", label: "测试资料乙" }], allowSupplement: false }] }]]);
    if (prompt.includes("长文")) return answer("测试长文与宽内容。\n\n" + "阅读区域应保持可用，长文本自然换行。".repeat(25) + "\n\n```ts\nconst fixture = '" + "wide_".repeat(70) + "';\n```\n\n| 工作项 | 状态 | 说明 |\n| --- | --- | --- |\n| 测试宽表格 | 完成 | " + "宽表内容".repeat(30) + " |\n");
    return answer("测试提供商已完成整理。\n\n- 记录一个结论\n- 保留下一步行动");
  };
  const interrupted = await f.runtime.sendNew("research", "测试：中断后继续核对资料");
  await f.runtime.shutdown("app_backgrounded"); await f.runtime.foreground();
  const completed = await f.runtime.sendNew("review", "测试：完成本次资料整理"); await completed.completion;
  const historical = await f.runtime.sendNew("organizer", "测试：历史整理结果（受控日期）"); await historical.completion;
  // A controlled past date tests date grouping. The message/run still comes from the real runtime.
  await f.store.updateSession(historical.taskId, (task: any) => { task.taskCompletedAt = Date.now() - 10 * 86400000; });
  const waiting = await f.runtime.sendNew("organizer", "测试：等你回应的资料整理");
  const financeWaiting = await f.runtime.sendNew("finance", "测试：等你回应的账目分类");
  const running = await f.runtime.sendNew("organizer", "测试：正在进行的笔记整理");
  f.m6Tasks = { interrupted: interrupted.taskId, completed: completed.taskId, historical: historical.taskId, waiting: waiting.taskId, financeWaiting: financeWaiting.taskId, running: running.taskId };
  await f.services.getTodoStore().addTodo({ title: "测试：核对页面外观", dueDate: new Date().toLocaleDateString("sv-SE") });
  await f.host.app.vault.create("journal/2026-10-19.md", "# 测试日记\n今天验证移动页面。");
  await f.host.app.vault.create("outputs/英文日记/2026-10-19.md", "# Test diary\nTest note for the existing-file bridge.");
  f.plugin.workbench.invalidate(); await f.store.flush();
}
