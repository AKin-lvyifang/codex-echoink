import assert from "node:assert/strict";
import { answer } from "./host.mjs";

export async function mobileLifecycleScenarios(api, win, test, setup) {
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const until = async predicate => {
    const deadline = Date.now() + 4000;
    while (!predicate() && Date.now() < deadline) await tick();
    assert.ok(predicate(), "lifecycle must settle without a Provider response");
  };
  await test("actual plugin visibility lifecycle interrupts both tasks and foreground never resumes queues", async () => {
    const calls = []; let hold = true, visibility = "visible", refreshes = 0;
    const f = await setup("openai-completions", request => {
      calls.push(JSON.parse(request.body));
      return hold ? new Promise(() => {}) : Promise.resolve(answer("openai-completions", "explicitly resumed"));
    });
    const previous = Object.getOwnPropertyDescriptor(win.document, "visibilityState");
    Object.defineProperty(win.document, "visibilityState", { configurable: true, get: () => visibility });
    const plugin = new api.EchoInkMobilePlugin(f.app, { id: "codex-echoink", version: "fixture" });
    Object.assign(plugin, { runtime: f.runtime, accountService: { async refresh() { refreshes++; }, dispose() {} } });
    try {
      await f.runtime.initialize(); plugin.registerTaskLifecycle(); plugin.registerTaskLifecycle();
      const a = f.store.session.id, b = (await f.store.createSession()).id;
      const first = await f.runtime.submit("A background", a), second = await f.runtime.submit("B background", b);
      void first.completion.catch(() => {}); void second.completion.catch(() => {});
      await until(() => calls.length === 2);
      const queued = await f.runtime.submit("A must stay paused", a); void queued.completion.catch(() => {});
      visibility = "hidden"; win.document.dispatchEvent(new win.Event("visibilitychange"));
      await until(() => !f.runtime.isBusy(a) && !f.runtime.isBusy(b)); await f.store.flush();
      for (const id of [a, b]) {
        assert.equal(f.store.getSession(id).taskStatus, "interrupted");
        assert.equal(f.store.getSession(id).interruption.reason, "app_backgrounded");
      }
      const interruption = f.store.getSession(a).interruption;
      win.document.dispatchEvent(new win.Event("visibilitychange")); await tick(); await f.store.flush();
      assert.deepEqual(f.store.getSession(a).interruption, interruption);
      visibility = "visible"; win.document.dispatchEvent(new win.Event("visibilitychange"));
      win.dispatchEvent(new win.Event("pageshow")); await tick();
      assert.equal(refreshes, 1); assert.equal(calls.length, 2); assert.equal(f.store.getSession(a).queue.length, 1);
      hold = false;
      const resumed = await f.runtime.resumeTask(a, "explicit new input"); await resumed.completion;
      assert.equal(calls.length, 3); assert.equal(f.store.getSession(a).queue.length, 1);
      assert.equal(f.store.getSession(b).taskStatus, "interrupted");
    } finally {
      plugin.unload(); f.runtime.dispose(); await f.store.flush();
      if (previous) Object.defineProperty(win.document, "visibilityState", previous); else delete win.document.visibilityState;
    }
  });
}
