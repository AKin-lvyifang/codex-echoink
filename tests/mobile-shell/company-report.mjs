import assert from "node:assert/strict";

/** Uses the real iPhone/iPad task page with old messages and no run metadata. */
export async function companyReportScenario(api, win, fixture, prefix) {
  const { store, runtime, ctx } = fixture, id = store.session.id;
  const report = (name, taskId, outcome) => `〔员工汇报〕${name}：${outcome}\n任务：整理资料\n摘要：${outcome === "没做成" ? "路径不存在" : "旧摘要"}\n任务编号：${taskId}`;
  const assistant = (value, timestamp) => ({ role: "assistant", content: [{ type: "text", text: value }], timestamp, stopReason: "stop", api: "openai-completions", provider: "custom", model: "fixture-model", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const records = [
    { role: "user", content: "帮我整理资料", timestamp: 1 }, assistant("正在处理原任务", 2),
    { role: "user", content: report("旧通才", "task-one", "做完了"), timestamp: 3 },
    { role: "user", content: report("研究员", "task-two", "没做成"), timestamp: 4 }, assistant("资料已整理，路径需要确认。", 5)
  ];
  await store.patchSession(id, { companyRole: "router", taskStatus: "completed", messages: records, runs: [] });
  const page = api.createTaskPage(ctx, id); ctx.shell.mount(page);
  const stream = page.content.querySelector(`.${prefix}-task-stream`);
  assert.equal(stream.querySelectorAll(`.${prefix}-task-user`).length, 1);
  let source = stream.querySelector(".echoink-report-source");
  assert.equal(source.textContent, "2 份汇报 · 1 份没做成");
  const precedingAnswer = [...stream.children].find(node => node.textContent === "正在处理原任务");
  assert.ok(precedingAnswer.compareDocumentPosition(source) & win.Node.DOCUMENT_POSITION_FOLLOWING);
  source.click(); assert.equal(source.getAttribute("aria-expanded"), "true");
  await store.updateSession(id, task => { task.messages.push(assistant("补充回答，触发重绘。", 6)); }); runtime.onChange();
  source = stream.querySelector(".echoink-report-source");
  assert.equal(source.getAttribute("aria-expanded"), "true");
  assert.equal(stream.querySelectorAll(".echoink-report-item").length, 2);
  assert.match(stream.querySelector(".echoink-report-details").textContent, /旧摘要/u);
  source.click(); assert.equal(stream.querySelector(".echoink-report-details").hidden, true);

  // A later human request after a stop cannot take ownership of the orphan report.
  await store.patchSession(id, { messages: [records[0], records[2], { role: "user", content: "换个问题", timestamp: 7 }, assistant("新问题的回答", 8)] }); runtime.onChange();
  const standalone = stream.querySelector(".echoink-report-source");
  assert.equal(standalone.textContent, "旧通才交回");
  assert.ok(standalone.parentElement.nextElementSibling.classList.contains(`${prefix}-task-user`));
  page.dispose?.();
}
