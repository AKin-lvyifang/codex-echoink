import assert from "node:assert/strict";

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
const interruption = { at: 1792454400123, reason: "app_backgrounded", stage: "等待模型" };
function snapshot(taskId, fingerprint = "snapshot-one") {
  return { taskId, fingerprint, checkedAt: 1792454400200,
    issues: [{ operationId: "private-operation-id", target: "测试/很长的目标路径/已有笔记.md", status: "unknown", label: "原写入目标当前不存在" }], operations: [], observations: [] };
}

/** Isolated UI contract fixture. Core resume safety is verified by its own tests. */
function resumeContract(f, inspect = taskId => snapshot(taskId), gate = undefined) {
  const views = new Map(), pending = new Map();
  const baseState = f.runtime.stateFor.bind(f.runtime);
  const calls = [], cancelled = [], admitted = [];
  const refresh = () => f.runtime.onChange();
  const patch = (taskId, change) => { views.set(taskId, { ...views.get(taskId), ...change }); refresh(); };
  f.runtime.stateFor = taskId => ({ ...baseState(taskId), ...views.get(taskId) });
  f.runtime.resumeTask = async (taskId, text, fingerprint) => {
    calls.push({ taskId, text, fingerprint });
    const cancellation = deferred(); pending.set(taskId, cancellation);
    patch(taskId, { resuming: true, error: "" });
    try {
      if (gate) await Promise.race([gate.promise, cancellation.promise]);
      const checked = inspect(taskId);
      if (checked.issues.length && fingerprint !== checked.fingerprint) {
        patch(taskId, { resumeReview: checked, resuming: false });
        throw Object.assign(new Error("继续前需要核对当前结果。"), { code: "mobile_resume_review_required" });
      }
      await f.store.updateSession(taskId, task => { task.taskStatus = "running"; if (text !== undefined && task.draft === text) task.draft = ""; });
      admitted.push({ taskId, text, fingerprint }); patch(taskId, { resuming: false, resumeReview: undefined, interruption: undefined, busy: true });
      return { taskId, queued: false, completion: Promise.resolve() };
    } finally { if (pending.get(taskId) === cancellation) pending.delete(taskId); }
  };
  f.runtime.cancelResume = async taskId => {
    cancelled.push(taskId); pending.get(taskId)?.reject(new Error("已取消继续准备。"));
    patch(taskId, { resuming: false, resumeReview: undefined });
  };
  return { calls, cancelled, admitted, patch };
}
async function seedInterrupted(f, taskId = f.store.session.id) {
  await f.store.patchSession(taskId, { messages: [{ role: "user", content: "原任务历史", timestamp: 1 }], taskStatus: "interrupted", taskInterruptedAt: interruption.at, draft: "继续前保留的补充输入" });
}

export async function runMobileTaskResumeUIScenarios(test, fixture, until) {
  for (const tablet of [false, true]) await test(`${tablet ? "iPad" : "iPhone"} resume UI contract shows recorded interruption and S5 facts without internal IDs`, async () => {
    let providerCalls = 0; const f = await fixture(async () => { providerCalls++; throw new Error("no request before confirmation"); }, tablet);
    try {
      const taskId = f.store.session.id; await seedInterrupted(f);
      const control = resumeContract(f, id => {
        const review = snapshot(id);
        review.issues.push({ operationId: "private-memory-operation", target: "private-memory-record-id", status: "conflict", label: "原记忆结果或版本尚未核实" });
        review.operations.push({ id: "private-memory-operation", toolName: "memory_write" }); return review;
      });
      control.patch(taskId, { interruption });
      const input = f.root.querySelector(".em-input"); const block = f.root.querySelector(".em-task-interruption");
      assert.ok(block.textContent.includes("应用进入后台时中断")); assert.ok(block.textContent.includes("停在：等待模型")); assert.equal(block.querySelector("time").dateTime, new Date(interruption.at).toISOString());
      f.click("从这里继续"); await until(() => !!f.root.querySelector(".em-task-resume-review"), "S5 review opens after preparation rejects for confirmation");
      const dialog = f.root.querySelector('[role="dialog"]'); assert.ok(dialog.textContent.includes("测试/很长的目标路径/已有笔记.md"));
      assert.ok(dialog.textContent.includes("结果未确认")); assert.ok(dialog.textContent.includes("内容有冲突")); assert.ok(dialog.textContent.includes("长期记忆"));
      for (const hidden of [taskId, "snapshot-one", "private-operation-id", "private-memory-operation", "private-memory-record-id"]) assert.equal(dialog.textContent.includes(hidden), false);
      const actions = f.root.querySelector(".em-task-question-actions"); assert.equal(actions.lastElementChild.textContent, "我已核对，请基于现状继续");
      assert.equal(f.root.querySelector(".em-input"), input); assert.equal(input.value, "继续前保留的补充输入");
      f.click("关闭弹层"); await settle(); assert.equal(control.admitted.length, 0); assert.equal(providerCalls, 0); assert.equal(control.cancelled.at(-1), taskId); assert.equal(f.store.session.draft, "继续前保留的补充输入");
      f.click("从这里继续"); await until(() => control.calls.length === 2 && !!f.root.querySelector(".em-task-resume-review"), "closed review can be freshly prepared");
      f.click("暂不继续"); await settle(); assert.equal(f.root.querySelector('[role="dialog"]'), null); assert.equal(control.admitted.length, 0); assert.equal(providerCalls, 0);
    } finally { await f.close(); }
  });

  await test("resume UI contract disables duplicate prepare and cancelResume prevents a late preparation from admitting", async () => {
    const f = await fixture(async () => { throw new Error("should not request"); }); const gate = deferred();
    try {
      const id = f.store.session.id; await seedInterrupted(f); const control = resumeContract(f, taskId => ({ ...snapshot(taskId), issues: [] }), gate); control.patch(id, { interruption });
      const input = f.root.querySelector(".em-input"); f.click("从这里继续"); await until(() => control.calls.length === 1, "prepare begins");
      const resume = f.root.querySelector(".em-task-resume-button"); assert.equal(resume.disabled, true); assert.equal(f.root.querySelector(".em-send").disabled, true); assert.equal(resume.textContent, "准备中…"); resume.click();
      f.click("取消继续"); await until(() => control.cancelled.length === 1 && !f.root.querySelector(".em-task-resume-button").disabled, "prepare cancelled"); gate.resolve(); await settle();
      assert.equal(control.calls.length, 1); assert.equal(control.admitted.length, 0); assert.equal(f.store.session.taskStatus, "interrupted"); assert.equal(input.value, "继续前保留的补充输入"); assert.equal(f.root.querySelector('[role="dialog"]'), null);
    } finally { gate.resolve(); await f.close(); }
  });

  await test("S5 UI contract sends only its displayed fingerprint, preserves failed input and requires a fresh changed snapshot", async () => {
    const f = await fixture(async () => { throw new Error("contract admission owns this scenario"); });
    try {
      const id = f.store.session.id; await seedInterrupted(f); let currentFingerprint = "snapshot-one";
      const control = resumeContract(f, taskId => ({ ...snapshot(taskId, currentFingerprint), issues: [{ ...snapshot(taskId).issues[0], status: currentFingerprint === "snapshot-one" ? "unknown" : "conflict" }] })); control.patch(id, { interruption });
      f.click("从这里继续"); await until(() => !!f.root.querySelector(".em-task-resume-review"), "first review"); currentFingerprint = "snapshot-two";
      f.click("我已核对，请基于现状继续"); await until(() => control.calls.length === 2 && f.root.querySelector(".em-task-resume-review")?.textContent.includes("内容有冲突"), "changed target returns a fresh review");
      assert.equal(control.calls[1].fingerprint, "snapshot-one"); assert.equal(control.admitted.length, 0); assert.equal(f.store.session.draft, "继续前保留的补充输入");
      f.click("我已核对，请基于现状继续"); await until(() => control.admitted.length === 1 && !f.root.querySelector('[role="dialog"]'), "matching fresh fingerprint admits once");
      assert.equal(control.calls[2].fingerprint, "snapshot-two"); assert.equal(control.admitted[0].taskId, id); assert.equal(control.admitted[0].text, "继续前保留的补充输入");
    } finally { await f.close(); }
  });

  await test("background A resume preparation never opens A review or error in B and can be reopened on A", async () => {
    const f = await fixture(async () => { throw new Error("no provider"); }, true); const gate = deferred();
    try {
      const a = f.store.session.id; await seedInterrupted(f); const control = resumeContract(f, id => snapshot(id), gate); control.patch(a, { interruption });
      f.click("从这里继续"); await until(() => control.calls.length === 1, "A preparation");
      const b = await f.store.createSession("agent-b"); f.runtime.onChange(); gate.resolve(); await until(() => !!f.runtime.stateFor(a).resumeReview, "A background review ready");
      assert.equal(f.store.session.id, b.id); assert.equal(f.root.querySelector('[role="dialog"]'), null); assert.equal(f.root.querySelector(".em-task-interruption"), null); assert.equal(f.root.querySelector(".em-error").textContent.includes("核对"), false);
      await f.select(a); f.click("从这里继续"); await until(() => control.calls.length === 2 && !!f.root.querySelector(".em-task-resume-review"), "A review reopens only on A");
      assert.ok(control.calls.every(call => call.taskId === a)); assert.equal(control.cancelled.length, 0);
    } finally { gate.resolve(); await f.close(); }
  });

  await test("cancelled old question cannot be reopened from its retained UI callback", async () => {
    const f = await fixture(async () => { throw new Error("no old question request"); });
    try {
      const id = f.store.session.id; await seedInterrupted(f); const control = resumeContract(f); const interaction = { taskId: id, runId: "old-run", questionId: "old-question", status: "pending", kind: "question", createdAt: 1,
        questions: [{ questionId: "old-answer", prompt: "旧问题", selection: "single", options: [{ optionId: "old-option", label: "旧选项" }], allowSupplement: false }] };
      control.patch(id, { busy: true, interaction }); const oldButton = f.root.querySelector(".em-task-question-entry"); assert.ok(oldButton);
      control.patch(id, { busy: false, interaction: { ...interaction, status: "cancelled" }, interruption });
      assert.equal(f.root.querySelector(".em-task-question-entry"), null); oldButton.click(); await settle(); assert.equal(f.root.querySelector('[role="dialog"]'), null); assert.ok(f.root.querySelector(".em-task-resume-button")); assert.equal(control.admitted.length, 0);
    } finally { await f.close(); }
  });
}
