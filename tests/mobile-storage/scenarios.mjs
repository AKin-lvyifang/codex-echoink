import assert from "node:assert/strict";
import { StrictAdapter, legacyState, memory, SecretFixture } from "./fixtures.mjs";

const root = "plugin/mobile";
const instance = "instance-a";
const statePath = `${root}/devices/${instance}/state.json`;
const recoveryPath = `${statePath}.task-replace-backup.json`;
const legacyPath = `${root}/state.json`;
const legacyBytes = () => `  ${JSON.stringify(legacyState(), null, 2)}\n`;
const once = (condition, action = () => { throw new Error("INJECTED_FAILURE"); }) => {
  let fired = false;
  return event => { if (!fired && condition(event)) { fired = true; return action(event); } };
};

export async function runStorageScenarios({ MobileStore, getMobileTaskInstanceId }) {
  let passed = 0;
  const test = async (name, work) => { await work(); passed++; console.log(`ok ${passed} - ${name}`); };
  const create = async (adapter = new StrictAdapter(), id = instance) => { const store = new MobileStore(adapter, root, id); await store.load(); return { adapter, store }; };

  await test("fresh install writes one blank sol session and reopens the same identity", async () => {
    const { adapter, store } = await create();
    assert.equal(store.state.version, 2); assert.equal(store.state.instanceId, instance); assert.equal(store.state.revision, 0);
    assert.equal(store.state.sessions.length, 1); assert.equal(store.session.agentId, "sol"); assert.equal(store.session.draft, "");
    assert.equal(adapter.files.has(legacyPath), false);
    const reopened = new MobileStore(adapter, root, instance); await reopened.load(); assert.deepEqual(reopened.state, store.state);
  });

  await test("v1 migration preserves every old payload and backs up original bytes once", async () => {
    const original = legacyBytes(); const { adapter, store } = await create(new StrictAdapter({ [legacyPath]: original }));
    assert.equal(adapter.files.get(legacyPath), original);
    assert.equal(adapter.files.get(`${root}/devices/${instance}/legacy-v1-backup.json`), original);
    for (const old of legacyState().sessions) assert.deepEqual(store.getSession(old.id), { ...old, agentId: "sol" });
    assert.deepEqual(store.state.memories, legacyState().memories); assert.equal(store.state.memoryEnabled, false); assert.equal(store.state.permission, "full-access");
    assert.equal(store.session.id, "old-b"); assert.equal(store.getSession("old-a").taskStatus, undefined); assert.equal(store.getSession("old-a").runs, undefined);
    assert.deepEqual(store.state.topLevelExtension, legacyState().topLevelExtension);
    await store.patchSession("old-a", { draft: "v2新增草稿" });
    const newest = adapter.files.get(statePath); adapter.files.set(legacyPath, original.replace("甲草稿", "过期变动"));
    adapter.calls.length = 0; const reopened = new MobileStore(adapter, root, instance); await reopened.load();
    assert.equal(adapter.files.get(statePath), newest); assert.equal(reopened.getSession("old-a").draft, "v2新增草稿");
    assert.equal(adapter.calls.some(call => call.path === legacyPath), false);
    assert.equal(adapter.files.get(`${root}/devices/${instance}/legacy-v1-backup.json`), original);
  });

  await test("empty valid v1 retains composer compatibility", async () => {
    const old = legacyState(); old.sessions = []; old.activeSessionId = "";
    const { store } = await create(new StrictAdapter({ [legacyPath]: JSON.stringify(old) }));
    assert.equal(store.state.sessions.length, 1); assert.equal(store.session.agentId, "sol");
  });

  await test("views and saved return values cannot mutate the authority; save only flushes", async () => {
    const { store, adapter } = await create(); const original = store.state;
    store.state.sessions[0].draft = "outside"; store.session.tools.fake = { startedAt: 1 }; store.getSession(store.session.id).messages.push({ role: "user", content: "outside" });
    await store.save(); assert.deepEqual(store.state, original);
    const added = await store.createSession("planner"); added.draft = "outside";
    assert.equal(store.getSession(added.id).draft, ""); assert.equal(store.getSession("missing"), undefined);
    assert.deepEqual(JSON.parse(adapter.files.get(statePath)), store.state);
  });

  await test("interleaved tasks, read markers, pending questions, memory revisions and archive share one queue", async () => {
    const { store, adapter } = await create(); const a = store.session.id; const b = (await store.createSession("planner")).id;
    const events = [
      store.updateSession(a, draft => { draft.messages.push({ role: "user", content: "甲问题", timestamp: 1 }); draft.draft = "甲输入"; }),
      store.updateSession(b, draft => { draft.messages.push({ role: "assistant", content: "乙回答", timestamp: 2 }); draft.unreadAnswerAt = 2; }),
      store.update(draft => { draft.memories.push(memory("shared")); }),
      store.patchSession(a, { pendingResponse: { runId: "run-a", questionId: "q-a", kind: "confirmation" }, runs: [{ id: "run-a", startedAt: 2, status: "waiting" }] }),
      store.updateSession(b, draft => { draft.lastReadAt = 3; delete draft.unreadAnswerAt; }),
      store.update(draft => {
        const at = draft.memories.findIndex(item => item.id === "shared"); assert.equal(draft.memories[at].revision, 1);
        draft.memories[at] = { ...draft.memories[at], revision: 2, content: "队列内更新" };
      }),
      store.archiveAndCreateSession(a, 5),
      store.patchSession(b, { draft: "乙独立输入", draftContext: { attachments: [], selectedModel: "fixture-model", selectedPermission: "read-only" } }),
      store.update(draft => { draft.newTaskDrafts.planner = { text: "新任务输入", attachments: [] }; }),
      store.setPermission("read-only"), store.setMemoryEnabled(false)
    ];
    await Promise.all(events);
    assert.equal(store.state.revision, 12); assert.equal(store.getSession(a).draft, "甲输入"); assert.equal(store.getSession(a).archivedAt, 5);
    assert.equal(store.getSession(a).pendingResponse.questionId, "q-a"); assert.equal(store.getSession(a).runs[0].status, "waiting");
    assert.equal(store.getSession(b).lastReadAt, 3); assert.equal(store.getSession(b).unreadAnswerAt, undefined); assert.equal(store.getSession(b).draft, "乙独立输入");
    assert.equal(store.state.memories[0].revision, 2); assert.equal(store.state.memories[0].content, "队列内更新");
    assert.equal(store.state.permission, "read-only"); assert.equal(store.state.memoryEnabled, false); assert.equal(store.state.newTaskDrafts.planner.text, "新任务输入");
    const reopened = new MobileStore(adapter, root, instance); await reopened.load(); assert.deepEqual(reopened.state, store.state);
    await store.restoreSession(a); assert.equal(store.session.id, a); assert.equal(store.session.archivedAt, undefined);
    await store.selectSession(b); assert.equal(store.state.page.taskId, b); assert.equal(store.session.agentId, "planner");
  });

  await test("patches copy input at submission and merge with latest committed state", async () => {
    const { store, adapter } = await create(); const id = store.session.id;
    let resume; let entered; const started = new Promise(resolve => { entered = resolve; });
    adapter.hook = once(event => event.op === "write" && event.path.endsWith(".tmp"), async () => { entered(); await new Promise(resolve => { resume = resolve; }); });
    const prior = store.patchSession(id, { title: "先提交的标题" }); await started;
    const patch = { draft: "提交时输入", tools: { t: { startedAt: 1 } } }; const later = store.patchSession(id, patch);
    patch.draft = "外部已变"; patch.tools.t.startedAt = 99; resume(); await Promise.all([prior, later]);
    assert.equal(store.session.title, "先提交的标题"); assert.equal(store.session.draft, "提交时输入"); assert.equal(store.session.tools.t.startedAt, 1);
  });

  await test("Agent handoff moves live and archived tasks once, retaining history, snapshots and unsent drafts", async () => {
    const { store, adapter } = await create();
    const active = await store.createSession("planner");
    const archived = await store.createSession("planner");
    const snapshot = { agentId: "planner", name: "原执行者", position: "计划", styleId: "analysis", capabilityIds: ["journal"] };
    await store.update(draft => {
      for (const session of draft.sessions.filter(item => item.agentId === "planner")) {
        session.draft = `任务输入 ${session.id}`;
        session.messages.push({ role: "user", content: "历史原文", timestamp: 1 });
        session.pendingResponse = { runId: `run-${session.id}`, questionId: "q", kind: "question" };
        session.runs = [{ id: `run-${session.id}`, startedAt: 1, status: "interrupted", interruptedAt: 2, agentSnapshot: snapshot }];
      }
      draft.sessions.find(item => item.id === archived.id).archivedAt = 3;
      draft.page = { kind: "list", agentId: "planner" };
      draft.newTaskDrafts = { sol: { text: "总助草稿", attachments: [] }, planner: { text: "计划草稿", attachments: [] } };
    });
    const before = store.state;
    await store.handoffAgentTasks("planner");
    assert.equal(store.state.revision, before.revision + 1);
    assert.deepEqual(store.state.sessions, before.sessions.map(session => session.agentId === "planner" ? { ...session, agentId: "sol" } : session));
    assert.equal(store.getSession(active.id).agentId, "sol"); assert.equal(store.getSession(archived.id).archivedAt, 3);
    assert.deepEqual(store.state.page, { kind: "list", agentId: "sol" });
    assert.deepEqual(store.state.newTaskDrafts, before.newTaskDrafts); assert.equal(store.state.activeSessionId, before.activeSessionId);
    const reopened = new MobileStore(adapter, root, instance); await reopened.load(); assert.deepEqual(reopened.state, store.state);
  });

  await test("failed or invalid Agent handoff leaves all task ownership and page state unchanged", async () => {
    const { store, adapter } = await create();
    await store.createSession("planner"); await store.createSession("planner");
    await store.update(draft => { draft.page = { kind: "list", agentId: "planner" }; });
    const before = store.state; const disk = adapter.files.get(statePath);
    adapter.hook = once(event => event.op === "write" && event.path.endsWith(".tmp"));
    await assert.rejects(store.handoffAgentTasks("planner"), /INJECTED_FAILURE/);
    assert.deepEqual(store.state, before); assert.equal(adapter.files.get(statePath), disk);
    adapter.hook = undefined;
    await assert.rejects(store.handoffAgentTasks("sol"), /总助任务不能移交/);
    await assert.rejects(store.handoffAgentTasks(""), /来源无效/);
    assert.deepEqual(store.state, before); assert.equal(adapter.files.get(statePath), disk);
  });

  await test("throwing, async and stale-revision mutations never publish or write", async () => {
    const { store, adapter } = await create(); const original = adapter.files.get(statePath);
    await assert.rejects(store.update(draft => { draft.sessions[0].draft = "failed"; throw new Error("MUTATION_FAILED"); }), /MUTATION_FAILED/);
    await assert.rejects(store.update(async draft => { draft.sessions[0].draft = "async"; }), /必须同步/);
    await store.update(draft => { draft.memories.push(memory("m")); });
    await store.update(draft => { draft.memories[0] = { ...draft.memories[0], revision: 2 }; });
    const before = store.state;
    await assert.rejects(store.update(draft => { if (draft.memories[0].revision !== 1) throw new Error("REVISION_CONFLICT"); draft.memories = []; }), /REVISION_CONFLICT/);
    assert.deepEqual(store.state, before); assert.notEqual(adapter.files.get(statePath), original);
    await assert.rejects(store.selectSession("missing"), /不存在/); await assert.rejects(store.restoreSession("missing"), /不存在/);
    await assert.rejects(store.archiveAndCreateSession("missing"), /不存在/); assert.deepEqual(store.state, before);
  });

  const failurePoints = [
    ["temporary write", e => e.op === "write" && e.path.endsWith(".tmp")],
    ["park old state", e => e.op === "rename" && e.path === statePath && e.to === recoveryPath],
    ["parked backup read", e => e.op === "read" && e.path === recoveryPath],
    ["install rename", e => e.op === "rename" && e.path.endsWith(".tmp") && e.to === statePath],
    ["installed readback", (e, adapter) => e.op === "read" && e.path === statePath && JSON.parse(adapter.files.get(statePath)).revision === 1],
    ["installed mismatch", (e, adapter) => e.op === "read" && e.path === statePath && JSON.parse(adapter.files.get(statePath)).revision === 1, () => "CORRUPTED_READBACK"]
  ];
  for (const [name, condition, action] of failurePoints) await test(`failed ${name} restores disk and leaves authority unchanged`, async () => {
    const { store, adapter } = await create(); const before = store.state; const disk = adapter.files.get(statePath);
    adapter.hook = once(e => condition(e, adapter), action);
    await assert.rejects(store.patchSession(store.session.id, { draft: "未提交输入" }));
    assert.deepEqual(store.state, before); assert.equal(adapter.files.get(statePath), disk);
    await assert.rejects(store.flush()); adapter.hook = undefined;
    await store.patchSession(store.session.id, { draft: "重试成功" }); assert.equal(store.session.draft, "重试成功");
    assert.equal(store.state.revision, 1);
  });

  await test("readback failure plus failed recovery retains candidate and backup and blocks later writes", async () => {
    const { store, adapter } = await create(); const before = store.state; const oldBytes = adapter.files.get(statePath);
    let readFailed = false;
    adapter.hook = e => {
      if (!readFailed && e.op === "read" && e.path === statePath && JSON.parse(adapter.files.get(statePath)).revision === 1) { readFailed = true; throw new Error("READBACK_FAILED"); }
      if (readFailed && e.op === "rename" && e.path === recoveryPath) throw new Error("RESTORE_FAILED");
    };
    await assert.rejects(store.patchSession(store.session.id, { draft: "候选输入" }), /恢复|保存/);
    assert.deepEqual(store.state, before); assert.equal(adapter.files.get(recoveryPath), oldBytes);
    assert.equal([...adapter.files.keys()].some(file => file.includes(".failed-")), true);
    const writes = adapter.calls.filter(call => call.op === "write").length;
    await assert.rejects(store.patchSession(store.session.id, { title: "不应写入" }), /尚未成功加载或恢复/);
    assert.equal(adapter.calls.filter(call => call.op === "write").length, writes);
    adapter.hook = undefined;
    const reopened = new MobileStore(adapter, root, instance); await reopened.load(); assert.deepEqual(reopened.state, before);
  });

  const migrationFailures = [
    ["legacy backup write", e => e.op === "write" && e.path.endsWith("/legacy-v1-backup.json")],
    ["legacy backup read", e => e.op === "read" && e.path.endsWith("/legacy-v1-backup.json")],
    ["temporary write", e => e.op === "write" && e.path.endsWith(".tmp")],
    ["install rename", e => e.op === "rename" && e.path.endsWith(".tmp")],
    ["installed readback", e => e.op === "read" && e.path === statePath]
  ];
  for (const [name, condition] of migrationFailures) await test(`migration ${name} failure preserves v1 and retries without duplicate import`, async () => {
    const original = legacyBytes(); const adapter = new StrictAdapter({ [legacyPath]: original }); const store = new MobileStore(adapter, root, instance);
    const initial = store.state; adapter.hook = once(condition);
    await assert.rejects(store.load()); assert.equal(adapter.files.get(legacyPath), original); assert.deepEqual(store.state, initial);
    await assert.rejects(store.createSession(), /尚未成功加载/);
    assert.equal(adapter.files.has(statePath), false); adapter.hook = undefined;
    const retry = new MobileStore(adapter, root, instance); await retry.load(); assert.equal(retry.state.sessions.length, 2);
    assert.equal(adapter.files.get(`${root}/devices/${instance}/legacy-v1-backup.json`), original);
  });

  for (const [name, corrupt] of [
    ["unknown version", old => ({ ...old, version: 55 })], ["duplicate session", old => ({ ...old, sessions: [old.sessions[0], old.sessions[0]] })],
    ["duplicate memory", old => ({ ...old, memories: [old.memories[0], old.memories[0]] })], ["damaged session", old => ({ ...old, sessions: [{ ...old.sessions[0], messages: [null] }] })]
  ]) await test(`${name} in legacy is rejected without creating a partition`, async () => {
    const bytes = JSON.stringify(corrupt(legacyState())); const adapter = new StrictAdapter({ [legacyPath]: bytes });
    const store = new MobileStore(adapter, root, instance); await assert.rejects(store.load());
    assert.deepEqual([...adapter.files], [[legacyPath, bytes]]);
  });

  for (const [name, mutate] of [
    ["unknown version", value => { value.version = 99; }], ["wrong owner", value => { value.instanceId = "someone-else"; }],
    ["duplicate session", value => { value.sessions.push(value.sessions[0]); }], ["invalid revision", value => { value.revision = -1; }],
    ["invalid page", value => { value.page = { kind: "detail", taskId: "missing" }; }], ["duplicate run", value => { value.sessions[0].runs = [{ id: "r", startedAt: 1 }, { id: "r", startedAt: 2 }]; }],
    ["duplicate reply text", value => { value.sessions[0].draftContext = { text: "second source", attachments: [] }; }],
    ["damaged memory payload", value => { value.memories = [memory("m")]; value.memories[0].content = null; }],
    ["damaged pending response", value => { value.sessions[0].pendingResponse = { runId: "r", questionId: "q", kind: "not-a-kind" }; }],
    ["damaged run metadata", value => { value.sessions[0].runs = [{ id: "r", startedAt: 1, status: "invented-success" }]; }],
    ["duplicate run across tasks", value => { value.sessions[0].runs = [{ id: "r", startedAt: 1 }]; value.sessions.push({ ...value.sessions[0], id: "other" }); }],
    ["damaged JSON", () => "{broken"]
  ]) await test(`${name} in v2 is retained and never replaced with v1`, async () => {
    const { adapter, store } = await create(); const value = store.state; const raw = mutate(value); const damaged = typeof raw === "string" ? raw : JSON.stringify(value);
    adapter.files.set(statePath, damaged); adapter.files.set(legacyPath, legacyBytes()); adapter.calls.length = 0;
    const reopened = new MobileStore(adapter, root, instance); await assert.rejects(reopened.load()); await assert.rejects(reopened.createSession());
    assert.equal(adapter.files.get(statePath), damaged); assert.equal(adapter.calls.some(e => e.op === "write" || e.op === "rename" || e.path === legacyPath), false);
  });

  await test("optimistic conflict preserves externally installed state and blocks stale writer", async () => {
    const { adapter, store } = await create(); const external = { ...store.state, revision: 10 }; external.sessions[0].draft = "外部保存";
    const externalBytes = JSON.stringify(external); adapter.files.set(statePath, externalBytes);
    await assert.rejects(store.patchSession(store.session.id, { draft: "旧进程" }), /资料已变化/);
    await assert.rejects(store.patchSession(store.session.id, { draft: "再试" }), /尚未成功加载或恢复/); assert.equal(adapter.files.get(statePath), externalBytes);
  });

  await test("instance A/B and Vault 甲/乙 stay isolated, including copied foreign partitions", async () => {
    const vaultA = new StrictAdapter(); const vaultB = new StrictAdapter();
    const stores = [];
    for (const [adapter, vault, suffix] of [[vaultA, "甲", "vault-a"], [vaultB, "乙", "vault-b"]]) for (const device of ["a", "b"]) {
      const id = `${device}-${suffix}`;
      const { store } = await create(adapter, id); await store.patchSession(store.session.id, { draft: `${vault}-${id}` }); stores.push([adapter, store, vault, id]);
    }
    // A copied foreign directory remains on disk; B only addresses its own identity.
    for (const [file, bytes] of vaultA.files) if (file.includes("/devices/a-vault-a/")) vaultB.files.set(file, bytes);
    for (const [adapter, store, vault, id] of stores) {
      adapter.calls.length = 0; const reopened = new MobileStore(adapter, root, id); await reopened.load(); assert.equal(reopened.session.draft, `${vault}-${id}`);
      assert.equal(adapter.calls.some(e => e.path.includes("/devices/") && !e.path.startsWith(`${root}/devices/${id}/`)), false);
    }
    const recipient = new StrictAdapter(Object.fromEntries(vaultA.files)); const foreignPath = `${root}/devices/a-vault-a/state.json`;
    const beforeForeign = recipient.files.get(foreignPath); recipient.calls.length = 0;
    const b = new MobileStore(recipient, root, "new-device"); await b.load(); assert.equal(b.state.sessions.length, 1); assert.equal(b.session.draft, "");
    assert.equal(recipient.files.get(foreignPath), beforeForeign); assert.equal(recipient.calls.some(e => e.path.includes("/devices/a-vault-a/")), false);
    for (const bad of ["../a", "a/b", "/a", "a\\b", ".", "..", "", undefined]) assert.throws(() => new MobileStore(recipient, root, bad), /实例标识无效/);
  });

  await test("explicit rollback keeps new v2 increments while old reader sees original v1 only", async () => {
    const original = legacyBytes(); const { adapter, store } = await create(new StrictAdapter({ [legacyPath]: original }));
    const added = await store.createSession("planner"); await store.patchSession(added.id, { draft: "回退时必须保留的新内容" });
    const v2 = adapter.files.get(statePath); const backupPath = `${root}/devices/${instance}/rollback-v2-snapshot.json`;
    await adapter.write(backupPath, v2);
    const oldReader = JSON.parse(await adapter.read(legacyPath)); assert.equal(oldReader.sessions.some(session => session.id === added.id), false);
    assert.equal(adapter.files.get(backupPath), v2); assert.equal(JSON.parse(adapter.files.get(backupPath)).sessions.find(session => session.id === added.id).draft, "回退时必须保留的新内容");
    assert.equal(adapter.files.get(legacyPath), original);
    const reopened = new MobileStore(adapter, root, instance); await reopened.load(); assert.equal(reopened.getSession(added.id).draft, "回退时必须保留的新内容");
  });

  await test("identity is independent, namespace-scoped, stable after restart and coalesced concurrently", async () => {
    const secret = new SecretFixture(); const namespace = "echoink:plugin/mobile";
    const ids = await Promise.all(Array.from({ length: 30 }, () => getMobileTaskInstanceId(secret, namespace)));
    assert.equal(new Set(ids).size, 1); assert.equal(secret.writes, 1);
    const restarted = new SecretFixture(); restarted.values = new Map(secret.values);
    assert.equal(await getMobileTaskInstanceId(restarted, namespace), ids[0]); assert.equal(restarted.writes, 0);
    assert.notEqual(await getMobileTaskInstanceId(secret, `${namespace}-other`), ids[0]);
    assert.notEqual(await getMobileTaskInstanceId(new SecretFixture(), namespace), ids[0]);
    assert.equal([...secret.values.keys()].every(key => key.startsWith("echoink-mobile-task-instance-") && !key.includes("membership")), true);
  });

  await test("unavailable, unreadable, invalid and unconfirmed identity never falls back", async () => {
    const namespace = "echoink:plugin/mobile";
    await assert.rejects(getMobileTaskInstanceId(undefined, namespace), /不可用/);
    await assert.rejects(getMobileTaskInstanceId(new SecretFixture(), ""), /不可用/);
    await assert.rejects(getMobileTaskInstanceId({ getSecret() { throw new Error("LOCKED"); }, setSecret() {} }, namespace), /无法读取或确认保存/);
    await assert.rejects(getMobileTaskInstanceId({ getSecret() { return null; }, setSecret() { throw new Error("WRITE_FAILED"); } }, namespace), /无法读取或确认保存/);
    await assert.rejects(getMobileTaskInstanceId({ getSecret() { return null; }, setSecret() {} }, namespace), /无法读取或确认保存/);
    const secret = new SecretFixture(); const id = await getMobileTaskInstanceId(secret, namespace); const key = [...secret.values.keys()][0];
    secret.values.set(key, "../foreign"); await assert.rejects(getMobileTaskInstanceId(secret, namespace), /无法读取或确认保存/); assert.equal(secret.values.get(key), "../foreign");
    secret.values.set(key, id); assert.equal(await getMobileTaskInstanceId(secret, namespace), id);
  });

  console.log(`Mobile storage: ${passed} scenarios passed (memory fixtures; no native-device claim).`);
  return passed;
}
