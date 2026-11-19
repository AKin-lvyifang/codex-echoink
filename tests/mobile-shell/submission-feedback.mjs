import assert from "node:assert/strict";

export async function submissionFeedbackScenario(api, win, fixture, prefix) {
  const until = async check => {
    const end = Date.now() + 4000;
    while (!check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(check());
  };
  let fail = true, release;
  const held = new Promise(resolve => { release = resolve; });
  fixture.runtime.context = async () => { if (fail) throw new Error("合成准备失败"); await held; return ""; };
  const id = fixture.store.session.id, page = api.createTaskPage(fixture.ctx, id);
  fixture.ctx.shell.mount(page);
  const input = page.footer.querySelector("textarea"); input.value = "失败和重试只显示当前消息的反馈";
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  page.footer.querySelector(`.${prefix}-composer-send`).click();
  try {
    await until(() => !!page.content.querySelector(".echoink-submission-error"));
    assert.equal(page.content.textContent.split("合成准备失败").length - 1, 1, "pre-admission failure has one explanation");
    assert.equal(page.content.querySelector(`.${prefix}-task-stopbox`), null, "the generic interrupted task does not duplicate the failed message's actions");
    fail = false;
    [...page.content.querySelectorAll("button")].find(button => button.textContent.trim() === "重试").click();
    await until(() => fixture.runtime.isBusy(id));
    assert.equal(page.content.querySelector(`.${prefix}-task-stopbox`), null, "retry preparation does not retain the previous failure card");
    assert.equal(page.content.querySelector(`.${prefix}-task-live`), null, "explicit preparation steps replace the stale generic stage");
    assert.ok(page.subtitle.includes("进行中"));
    const record = [...fixture.runtime.composerSubmissions.records.values()].find(record => record.owner === id);
    await fixture.runtime.cancelComposerSubmission(record.id);
    assert.equal(input.value, "失败和重试只显示当前消息的反馈");
  } finally { release(); }
}
