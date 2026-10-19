import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createHost } from "../mobile/host.mjs";

export async function runMobileRecoveryScenarios(api) {
  const { MobileStore, mobileTools, inspectMobileTaskResume, mobileResumeContext } = api;
  const hash = text => createHash("sha256").update(text).digest("hex");
  const signal = () => new AbortController().signal;
  const memory = { kind: "view", title: "表达偏好", content: "先说结论", recallWhen: "解释问题", basis: "explicit" };
  const note = { path: "输出/结果.md", content: "# 真实写入\n只保存一次。" };
  const asObject = value => JSON.parse(JSON.stringify(value));
  async function setup() {
    const host = createHost({}), store = new MobileStore(host.adapter, "plugin/mobile", "recovery-fixture");
    await store.load(); const taskId = store.session.id;
    let runCount = 0, callCount = 0;
    const begin = async () => {
      const runId = `run-${++runCount}`;
      await store.updateSession(taskId, task => {
        task.runs = [...(task.runs ?? []), { id: runId, startedAt: Date.now(), status: "running" }]; task.taskStatus = "running";
        task.messages.push({ role: "user", content: [{ type: "text", text: `本次运行 ${runId}` }], timestamp: Date.now() });
      });
      return runId;
    };
    const register = async (name, args, callId = `call-${++callCount}`) => {
      await store.updateSession(taskId, task => { task.messages.push({ role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: args }], timestamp: Date.now() }); });
      return callId;
    };
    const execute = async (runId, name, args, { resume, callId, abort } = {}) => {
      const id = await register(name, args, callId);
      const tools = mobileTools(host.app, store, () => "", () => null, undefined, taskId, undefined, { runId, ...(resume ? { resume } : {}) });
      const tool = tools.find(item => item.name === name); assert.ok(tool, `registered ${name}`);
      return tool.execute(id, args, abort?.signal ?? signal());
    };
    return { ...host, store, taskId, begin, register, execute,
      get operations() { return store.getSession(taskId).operations ?? []; },
      async snapshot() { return inspectMobileTaskResume(host.app, store, taskId); } };
  }
  let passed = 0;
  async function test(name, run) { await run(); passed++; console.log(`OK ${name}`); }

  await test("formal note_create persists prepared/started before create and exact-read completed afterwards", async () => {
    const f = await setup(), run = await f.begin(), seen = [], create = f.app.vault.create;
    f.app.vault.create = async (path, content) => {
      const saved = JSON.parse(f.files.get(f.store.statePath));
      seen.push(saved.sessions.find(task => task.id === f.taskId).operations[0].status);
      assert.equal(f.operations[0].status, "started");
      return create(path, content);
    };
    await f.execute(run, "note_create", note);
    assert.deepEqual(seen, ["started"]); assert.equal(f.operations[0].status, "completed");
    assert.equal(f.operations[0].targetWasMissing, true); assert.equal(f.operations[0].expectedHash, hash(note.content));
    const before = [...f.files], one = await f.snapshot(), two = await f.snapshot();
    assert.equal(one.issues.length, 0); assert.equal(one.fingerprint, two.fingerprint);
    assert.deepEqual([...f.files], before); assert.match(mobileResumeContext(one), /禁止重放/u);
  });

  await test("failed intent/start persistence has zero note effects and leaves the last durable stage", async () => {
    for (const stage of ["prepared", "started"]) {
      const f = await setup(), run = await f.begin(), call = await f.register("note_create", note), write = f.adapter.write;
      f.adapter.write = async (path, bytes) => {
        if (path.endsWith(".tmp") && bytes.includes(`\"status\":\"${stage}\"`) && bytes.includes('"toolName":"note_create"')) throw new Error(`FAIL_${stage}`);
        return write(path, bytes);
      };
      const tools = mobileTools(f.app, f.store, () => "", () => null, undefined, f.taskId, undefined, { runId: run });
      await assert.rejects(tools.find(tool => tool.name === "note_create").execute(call, note, signal()), new RegExp(`FAIL_${stage}`));
      assert.equal(f.files.has(note.path), false);
      assert.equal(f.operations.length, stage === "prepared" ? 0 : 1);
      if (stage === "started") assert.equal(f.operations[0].status, "prepared");
    }
  });

  await test("create-then-failure is read-only reconciled once; missing prior intent cannot claim completion", async () => {
    const f = await setup(), run = await f.begin(), create = f.app.vault.create;
    f.app.vault.create = async (path, content) => { await create(path, content); throw new Error("create callback lost"); };
    await assert.rejects(f.execute(run, "note_create", note), /create callback lost/u);
    assert.equal(f.operations[0].status, "started");
    const target = f.files.get(note.path), writes = f.writes.filter(path => path === note.path).length;
    const snapshot = await f.snapshot();
    assert.equal(snapshot.operations[0].status, "completed"); assert.equal(snapshot.issues.length, 0);
    assert.equal(f.files.get(note.path), target); assert.equal(f.writes.filter(path => path === note.path).length, writes);
    assert.equal((await f.snapshot()).fingerprint, snapshot.fingerprint);
    const legacy = await setup(); await legacy.begin(); await legacy.register("note_create", note);
    legacy.files.set(note.path, note.content);
    const unknown = await legacy.snapshot();
    assert.equal(unknown.operations.length, 0); assert.equal(unknown.issues[0].status, "unknown");
  });

  await test("note readback failure and final receipt failure retain the physical note plus started intent", async () => {
    for (const failure of ["readback", "receipt"]) {
      const f = await setup(), run = await f.begin(), read = f.adapter.read, write = f.adapter.write;
      let fail = true;
      f.adapter.read = async path => { if (fail && failure === "readback" && path === note.path) throw new Error("readback lost"); return read(path); };
      f.adapter.write = async (path, bytes) => {
        if (fail && failure === "receipt" && path.endsWith(".tmp") && bytes.includes('"toolName":"note_create"') && bytes.includes('"status":"completed"')) throw new Error("receipt lost");
        return write(path, bytes);
      };
      await assert.rejects(f.execute(run, "note_create", note), /lost/u);
      assert.equal(f.files.get(note.path), note.content); assert.equal(f.operations[0].status, "started");
      fail = false;
      const reopened = new MobileStore(f.adapter, "plugin/mobile", "recovery-fixture"); await reopened.load();
      assert.equal((await inspectMobileTaskResume(f.app, reopened, f.taskId)).operations[0].status, "completed");
    }
  });

  await test("changed content is a conflict; missing started target is unknown; neither may be replayed", async () => {
    for (const target of ["changed", "missing"]) {
      const f = await setup(), run = await f.begin(), create = f.app.vault.create;
      f.app.vault.create = async (path, content) => { if (target === "changed") await create(path, "用户已改写"); throw new Error("interrupted"); };
      await assert.rejects(f.execute(run, "note_create", note), /interrupted/u);
      const snapshot = await f.snapshot(); assert.equal(snapshot.issues[0].status, target === "changed" ? "conflict" : "unknown");
      const resumed = await f.begin(), before = [...f.files];
      await assert.rejects(f.execute(resumed, "note_create", { ...note, content: "不同内容也不能重放" }, { resume: snapshot }), /不能重放/u);
      assert.deepEqual([...f.files].filter(([path]) => path === note.path), before.filter(([path]) => path === note.path));
    }
  });

  await test("resume rechecks observed targets and live permission before an unrelated new note side effect", async () => {
    const f = await setup(), run = await f.begin(); await f.execute(run, "note_create", note);
    const snapshot = await f.snapshot(), resumed = await f.begin();
    f.files.set(note.path, "核对后又被编辑");
    await assert.rejects(f.execute(resumed, "note_create", { path: "输出/新工作.md", content: "新工作" }, { resume: snapshot }), /重新核对/u);
    assert.equal(f.files.has("输出/新工作.md"), false);
    const current = await f.snapshot(); await f.store.setPermission("read-only");
    const direct = mobileTools(f.app, f.store, () => "", () => null, undefined, f.taskId, undefined, { runId: resumed, resume: current });
    assert.ok(!direct.some(tool => tool.name === "note_create"));
  });

  await test("Memory and completed receipt commit atomically, then duplicate call/semantic writes are denied", async () => {
    const f = await setup(), run = await f.begin(); await f.execute(run, "memory_write", memory, { callId: "memory-once" });
    const saved = JSON.parse(f.files.get(f.store.statePath)), op = saved.sessions.find(task => task.id === f.taskId).operations[0];
    assert.equal(op.status, "completed"); assert.equal(op.target, saved.memories[0].id); assert.equal(op.completedRevision, 1);
    assert.equal(saved.memories.length, 1); assert.equal(f.operations.length, 1);
    assert.equal((await f.snapshot()).issues.length, 0);
    await assert.rejects(f.execute(run, "memory_write", memory, { callId: "memory-once" }), /重复执行/u);
    await assert.rejects(f.execute(run, "memory_write", memory), /重复执行/u);
    assert.equal(f.store.state.memories.length, 1); assert.equal(f.operations.length, 1);
    // Runtime settles a failed turn before offering resume; this also drains the rejected writer.
    await f.store.updateSession(f.taskId, task => {
      const old = task.runs.find(item => item.id === run); old.status = "interrupted"; old.interruptedAt = Date.now();
      task.taskStatus = "interrupted"; task.taskInterruptedAt = old.interruptedAt;
    });
    const snapshot = await f.snapshot();
    assert.equal(snapshot.operations[0].status, "completed");
    // A later rejected call has no intent of its own; it must never be inferred unwritten.
    assert.ok(snapshot.issues.every(issue => issue.status === "unknown"));
    const resumed = await f.begin();
    await assert.rejects(f.execute(resumed, "memory_write", { ...memory, targetId: op.target, content: "不能借确认重写旧目标" }, { resume: snapshot }), /不能重放/u);
    assert.equal(f.store.state.memories[0].content, memory.content);
  });

  await test("Memory disk failure publishes neither record nor receipt and existing target revisions are rechecked in queue", async () => {
    const f = await setup(), run = await f.begin(), write = f.adapter.write; let fail = true;
    f.adapter.write = async (path, bytes) => { if (fail && path.endsWith(".tmp") && bytes.includes('"toolName":"memory_write"')) throw new Error("memory transaction lost"); return write(path, bytes); };
    await assert.rejects(f.execute(run, "memory_write", memory), /transaction lost/u);
    assert.equal(f.store.state.memories.length, 0); assert.equal(f.operations.length, 0);
    fail = false;
    await assert.rejects(f.execute(run, "memory_write", memory), /不能重放/u);
    assert.equal(f.store.state.memories.length, 0); assert.equal(f.operations.length, 0);
    const clean = await setup(), freshRun = await clean.begin(); await clean.execute(freshRun, "memory_write", memory);
    const target = clean.store.state.memories[0].id, tools = mobileTools(clean.app, clean.store, () => "", () => null, undefined, clean.taskId, undefined, { runId: freshRun });
    const call = await clean.register("memory_write", { ...memory, targetId: target, content: "新内容" });
    const original = clean.store.update.bind(clean.store); let inject = true;
    clean.store.update = change => {
      if (inject) { inject = false; void original(draft => { draft.memories[0].revision++; }); }
      return original(change);
    };
    await assert.rejects(tools.find(tool => tool.name === "memory_write").execute(call, { ...memory, targetId: target, content: "新内容" }, signal()), /版本已变化/u);
    assert.equal(clean.store.state.memories[0].content, memory.content); assert.equal(clean.operations.length, 1);
  });

  await test("legacy receipt/call known targets block replay; unknown target blocks that write tool only", async () => {
    const f = await setup(); await f.begin(); await f.register("note_create", note, "legacy-note");
    await f.store.updateSession(f.taskId, task => { task.messages.push({ role: "toolResult", toolName: "memory_write", toolCallId: "legacy-memory", details: {}, content: [], isError: false, timestamp: Date.now() }); });
    const snapshot = await f.snapshot(); assert.equal(snapshot.issues.length, 2);
    const run = await f.begin();
    await assert.rejects(f.execute(run, "note_create", note, { resume: snapshot }), /不能重放/u);
    await assert.rejects(f.execute(run, "memory_write", { ...memory, content: "另一份记忆也不能绕过未知目标" }, { resume: snapshot }), /不能重放/u);
    await f.execute(run, "note_create", { path: "输出/真正新工作.md", content: "可基于现状做不同新工作" }, { resume: snapshot });
    assert.equal(f.files.has(note.path), false); assert.equal(f.files.has("输出/真正新工作.md"), true);
    const malformed = await setup(); await malformed.begin();
    await malformed.store.updateSession(malformed.taskId, task => {
      task.messages.push({ role: "assistant", content: [{ type: "toolCall", name: "note_create", arguments: {} }], timestamp: Date.now() });
    });
    const uncertain = await malformed.snapshot(); assert.equal(uncertain.issues[0].target, "目标未记录");
    const next = await malformed.begin();
    await assert.rejects(malformed.execute(next, "note_create", { path: "新目标.md", content: "未知目标不能换路径重放" }, { resume: uncertain }), /不能重放/u);
    assert.equal(malformed.files.has("新目标.md"), false);
  });

  await test("legacy unknown writes stay blocked after the resume run completes and ordinary turns follow", async () => {
    for (const unknownMemoryTarget of [false, true]) {
      const f = await setup(), oldRun = await f.begin();
      const seed = mobileTools(f.app, f.store, () => "").find(tool => tool.name === "memory_write");
      await seed.execute("old-memory-seed", memory, signal());
      const oldMemoryId = f.store.state.memories[0].id;
      await f.register("note_create", note, "legacy-note");
      if (unknownMemoryTarget) await f.store.updateSession(f.taskId, task => {
        task.messages.push({ role: "toolResult", toolName: "memory_write", toolCallId: "legacy-memory", details: {}, content: [], isError: false, timestamp: Date.now() });
      });
      else await f.register("memory_write", { ...memory, targetId: oldMemoryId, content: "原来的未确认更新" }, "legacy-memory");
      await f.store.updateSession(f.taskId, task => {
        task.runs.find(item => item.id === oldRun).status = "interrupted"; task.taskStatus = "interrupted";
      });
      const resume = await f.snapshot(), resumed = await f.begin();
      await f.execute(resumed, "note_create", { path: "输出/继续后的新工作.md", content: "不同的新工作" }, { resume });
      await f.store.updateSession(f.taskId, task => {
        task.runs.find(item => item.id === resumed).status = "completed"; task.taskStatus = "completed";
      });
      const normal = await f.begin(), notesBefore = f.writes.filter(path => path === note.path).length;
      const memoryBefore = asObject(f.store.state.memories), operationsBefore = f.operations.length;
      await assert.rejects(f.execute(normal, "note_create", { ...note, content: "普通发送也不能重放同一目标" }), /不能重放/u);
      await assert.rejects(f.execute(normal, "memory_write", { ...memory, ...(unknownMemoryTarget ? {} : { targetId: oldMemoryId }), content: "普通发送也不能重放旧记忆写入" }), /不能重放/u);
      assert.equal(f.files.has(note.path), false); assert.equal(f.writes.filter(path => path === note.path).length, notesBefore);
      assert.deepEqual(asObject(f.store.state.memories), memoryBefore); assert.equal(f.operations.length, operationsBefore);
      await f.execute(normal, "note_create", { path: "输出/普通发送的新工作.md", content: "新目标仍可写入" });
      assert.equal(f.files.get("输出/普通发送的新工作.md"), "新目标仍可写入");
    }
  });

  await test("same Provider call ID in another run cannot cover an older unknown write occurrence", async () => {
    const f = await setup(), old = await f.begin();
    await f.register("note_create", note, "call-1");
    await f.store.updateSession(f.taskId, task => { task.runs.find(run => run.id === old).status = "interrupted"; task.taskStatus = "interrupted"; });
    const newer = await f.begin(), nextNote = { path: "输出/另一个目标.md", content: "新运行的确切内容" };
    await f.execute(newer, "note_create", nextNote, { callId: "call-1" });
    const inspected = await f.snapshot();
    assert.equal(inspected.operations.length, 1); assert.equal(inspected.operations[0].target, nextNote.path);
    assert.equal(inspected.issues.length, 1); assert.equal(inspected.issues[0].target, note.path); assert.equal(inspected.issues[0].status, "unknown");
    assert.ok(inspected.observations.some(item => item.target === `note_create:${note.path}`));
    assert.ok(inspected.observations.some(item => item.target === `note_create:${nextNote.path}`));
    const resumed = await f.begin(), before = f.writes.filter(path => path === note.path).length;
    await assert.rejects(f.execute(resumed, "note_create", note, { callId: "call-1", resume: inspected }), /不能重放/u);
    assert.equal(f.files.has(note.path), false); assert.equal(f.writes.filter(path => path === note.path).length, before);
    assert.equal(f.files.get(nextNote.path), nextNote.content); assert.equal(f.operations.length, 1);
    const g = await setup(), current = await g.begin();
    await g.execute(current, "memory_write", memory, { callId: "call-1" });
    const savedMemory = asObject(g.store.state.memories);
    // An older M3 call can have identical request bytes and a reused ID but no known target.
    await g.store.updateSession(g.taskId, task => {
      task.runs.unshift({ id: "legacy-run", startedAt: 0, status: "interrupted" });
      task.messages.unshift({ role: "user", content: [{ type: "text", text: "旧M3输入" }], timestamp: 0 },
        { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "memory_write", arguments: memory }], timestamp: 1 });
    });
    const memoryReview = await g.snapshot();
    assert.equal(memoryReview.issues.length, 1); assert.equal(memoryReview.issues[0].target, "目标未记录");
    assert.equal(memoryReview.operations[0].status, "completed");
    const ordinary = await g.begin();
    await assert.rejects(g.execute(ordinary, "memory_write", { ...memory, content: "不同内容也不能绕过未知旧目标" }), /不能重放/u);
    assert.deepEqual(asObject(g.store.state.memories), savedMemory); assert.equal(g.operations.length, 1);
    await g.store.updateSession(g.taskId, task => { task.messages = task.messages.filter(message => message.role !== "user"); });
    assert.ok((await g.snapshot()).issues.every(issue => issue.status === "unknown"));
  });

  await test("completed Memory deduplication attributes request intent separately from the reused record hash", async () => {
    const f = await setup(), run = await f.begin();
    await f.execute(run, "memory_write", memory, { callId: "first-memory" });
    const stored = asObject(f.store.state.memories[0]), changedRequest = { ...memory, title: "新的请求标题", recallWhen: "不同请求触发词" };
    await f.execute(run, "memory_write", changedRequest, { callId: "dedup-memory" });
    const op = f.operations[1];
    assert.equal(f.store.state.memories.length, 1); assert.deepEqual(asObject(f.store.state.memories[0]), stored);
    assert.equal(op.target, stored.id); assert.equal(op.beforeRevision, stored.revision); assert.equal(op.completedRevision, stored.revision);
    assert.notEqual(op.expectedHash, api.mobileMemoryWriteHash(changedRequest));
    assert.equal((await f.snapshot()).issues.length, 0);
    // Persisted result refers to the actual reused record, not the request's differing fields.
    await f.store.updateSession(f.taskId, task => { task.messages.push({ role: "toolResult", toolName: "memory_write", toolCallId: "dedup-memory", details: stored, content: [], isError: false, timestamp: Date.now() }); });
    assert.equal((await f.snapshot()).issues.length, 0);
  });

  await test("invalid/missing real run rejects before effects, cancellation retains intent and standalone creates no fake run", async () => {
    const invalid = await setup();
    await assert.rejects(invalid.execute("no-run", "note_create", note), /运行已结束或中断/u); assert.equal(invalid.files.has(note.path), false);
    const f = await setup();
    const run = await f.begin(), create = f.app.vault.create, abort = new AbortController();
    f.app.vault.create = async (path, content) => { const file = await create(path, content); abort.abort(); return file; };
    await assert.rejects(f.execute(run, "note_create", note, { abort }), /已停止/u);
    assert.equal(f.files.get(note.path), note.content); assert.equal(f.operations[0].status, "completed");
    const standalone = await setup(), tools = mobileTools(standalone.app, standalone.store, () => "");
    await tools.find(tool => tool.name === "note_create").execute("fixture", { path: "兼容.md", content: "兼容" }, signal());
    assert.equal(standalone.store.getSession(standalone.taskId).runs, undefined); assert.equal(standalone.operations.length, 0);
    const stopped = new AbortController(); stopped.abort();
    await assert.rejects(inspectMobileTaskResume(f.app, f.store, f.taskId, stopped.signal), /已停止/u);
    assert.deepEqual(asObject(f.operations[0]).target, note.path);
  });
  console.log(`${passed} mobile write/recovery checks passed (real executors and v2 queue; memory-only targets).`);
}
