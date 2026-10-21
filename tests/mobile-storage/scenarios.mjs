import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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
const taskKeys = namespace => {
  const digest = createHash("sha256").update(namespace).digest("hex");
  return { legacy: `echoink-mobile-task-instance-${digest}`, current: `echoink-mobile-task-instance-${digest.slice(0, 32)}` };
};
const strictSecret = () => ({
  values: new Map(), writes: [],
  getSecret(key) {
    if (!/^[a-z0-9-]{1,64}$/.test(key)) throw new Error("INVALID_SECRET_KEY");
    return this.values.get(key) ?? null;
  },
  setSecret(key, value) {
    if (!/^[a-z0-9-]{1,64}$/.test(key)) throw new Error("INVALID_SECRET_KEY");
    this.writes.push(key); this.values.set(key, value);
  }
});
const localFixture = () => ({
  values: new Map(), writes: 0,
  loadLocalStorage(key) { return this.values.get(key); },
  saveLocalStorage(key, value) { this.writes++; this.values.set(key, value); }
});
const asyncSecret = base => ({
  async getSecret(key) { await Promise.resolve(); return base.getSecret(key); },
  async setSecret(key, value) { await Promise.resolve(); base.setSecret(key, value); }
});
const asyncLocal = base => ({
  async loadLocalStorage(key) { await Promise.resolve(); return base.loadLocalStorage(key); },
  async saveLocalStorage(key, value) { await Promise.resolve(); base.saveLocalStorage(key, value); }
});
// Production JSON.parse runs in the browser VM; compare serialized state across realms.
const plain = value => JSON.parse(JSON.stringify(value));

export async function runStorageScenarios({ MobileStore, getMobileTaskInstanceId, createMobileMembershipStorage }) {
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
    assert.match(store.unavailableReason, /资料已变化.*任务暂不可用/u);
    await assert.rejects(store.patchSession(store.session.id, { draft: "再试" }), /资料已变化.*任务暂不可用/u); assert.equal(adapter.files.get(statePath), externalBytes);
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

  await test("without a local port, unavailable, unreadable, invalid and unconfirmed identity still rejects", async () => {
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

  await test("strict native key limits reject the legacy write while new identity writes fit 64 characters", async () => {
    const namespace = "echoink:plugin/mobile"; const keys = taskKeys(namespace); const secret = strictSecret();
    assert.equal(keys.legacy.length, 93); assert.equal(keys.current.length, 61);
    assert.throws(() => secret.setSecret(keys.legacy, randomUUID()), /INVALID_SECRET_KEY/);
    const id = await getMobileTaskInstanceId(secret, namespace);
    assert.deepEqual(secret.writes, [keys.current]); assert.equal(secret.values.get(keys.current), id);
    const restarted = strictSecret(); restarted.values = new Map(secret.values);
    assert.equal(await getMobileTaskInstanceId(restarted, namespace), id); assert.deepEqual(restarted.writes, []);
  });

  await test("awaited asynchronous secret and local ports persist one concurrent identity and mirror it", async () => {
    const namespace = "async-vault"; const backing = strictSecret(); const backup = localFixture();
    const secret = asyncSecret(backing); const local = asyncLocal(backup);
    const ids = await Promise.all(Array.from({ length: 30 }, () => getMobileTaskInstanceId(secret, namespace, local)));
    assert.equal(new Set(ids).size, 1); assert.equal(backing.writes.length, 1); assert.equal(backup.writes, 1);
    assert.equal(backing.values.get(taskKeys(namespace).current), ids[0]);
    assert.equal(backup.values.get(taskKeys(namespace).current), ids[0]);
    assert.equal(await getMobileTaskInstanceId(undefined, namespace, asyncLocal(backup)), ids[0]);
    assert.equal(backup.writes, 1);
  });

  await test("a valid legacy UUID takes priority, remains untouched, and survives secret loss through its local mirror", async () => {
    const namespace = "legacy-vault"; const keys = taskKeys(namespace); const id = randomUUID();
    const secret = new SecretFixture(); const local = localFixture();
    secret.values.set(keys.legacy, id); secret.values.set(keys.current, randomUUID()); local.values.set(keys.current, randomUUID());
    assert.equal(await getMobileTaskInstanceId(secret, namespace, local), id);
    assert.equal(secret.writes, 0); assert.equal(secret.values.get(keys.legacy), id); assert.equal(local.values.get(keys.current), id);
    assert.equal(await getMobileTaskInstanceId(undefined, namespace, local), id); assert.equal(local.writes, 1);
  });

  await test("existing short-key and local-only identities are reused before any new UUID is created", async () => {
    const namespace = "existing-vault"; const key = taskKeys(namespace).current; const id = randomUUID();
    const secret = strictSecret(); const local = localFixture(); local.values.set(key, id);
    assert.equal(await getMobileTaskInstanceId(secret, namespace, local), id);
    assert.equal(secret.values.get(key), id); assert.equal(local.writes, 0);
    const mirrored = localFixture();
    assert.equal(await getMobileTaskInstanceId(secret, namespace, mirrored), id);
    assert.equal(mirrored.values.get(key), id); assert.equal(secret.writes.length, 1);
  });

  const failedSecrets = [
    ["absent", () => undefined],
    ["synchronous read throw", () => ({ getSecret() { throw new Error("LOCKED"); }, setSecret() { throw new Error("MUST_NOT_WRITE"); } })],
    ["asynchronous read rejection", () => ({ async getSecret() { throw new Error("LOCKED"); }, async setSecret() { throw new Error("MUST_NOT_WRITE"); } })],
    ["synchronous write throw", () => ({ getSecret() { return null; }, setSecret() { throw new Error("WRITE_FAILED"); } })],
    ["asynchronous write rejection", () => ({ async getSecret() { return null; }, async setSecret() { throw new Error("WRITE_FAILED"); } })],
    ["unconfirmed write", () => ({ async getSecret() { return null; }, async setSecret() {} })]
  ];
  for (const [name, makeSecret] of failedSecrets) await test(`secret ${name} falls back to a confirmed device-local identity and keeps it after restart`, async () => {
    const namespace = `fallback-${name}`; const local = localFixture(); const secret = makeSecret();
    const id = await getMobileTaskInstanceId(secret, namespace, asyncLocal(local));
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(local.values.get(taskKeys(namespace).current), id); assert.equal(local.writes, 1);
    const restarted = localFixture(); restarted.values = new Map(local.values);
    assert.equal(await getMobileTaskInstanceId(makeSecret(), namespace, asyncLocal(restarted)), id);
    assert.equal(restarted.writes, 0);
  });

  await test("a secret write rejection after commit mirrors the same candidate instead of creating another identity", async () => {
    const namespace = "partial-commit"; const secret = strictSecret(); const local = localFixture();
    const rejecting = { getSecret: key => secret.getSecret(key), async setSecret(key, value) { secret.setSecret(key, value); throw new Error("AFTER_COMMIT"); } };
    const id = await getMobileTaskInstanceId(rejecting, namespace, local);
    assert.equal(secret.values.get(taskKeys(namespace).current), id); assert.equal(local.values.get(taskKeys(namespace).current), id);
    assert.equal(await getMobileTaskInstanceId(secret, namespace, local), id);
  });

  await test("invalid saved UUIDs are never accepted or overwritten while a local backup can recover", async () => {
    const namespace = "damaged-vault"; const keys = taskKeys(namespace); const secret = new SecretFixture();
    secret.values.set(keys.legacy, "damaged-legacy"); secret.values.set(keys.current, "../foreign");
    const before = [...secret.values]; const local = localFixture(); const id = randomUUID(); local.values.set(keys.current, id);
    assert.equal(await getMobileTaskInstanceId(secret, namespace, local), id);
    assert.deepEqual([...secret.values], before); assert.equal(secret.writes, 0);
    await assert.rejects(getMobileTaskInstanceId(secret, namespace), /无法读取或确认保存/);
  });

  await test("a confirmed secret remains usable if the optional local mirror rejects", async () => {
    const secret = strictSecret(); const namespace = "mirror-failed";
    const local = { loadLocalStorage() { return null; }, async saveLocalStorage() { throw new Error("LOCAL_FAILED"); } };
    const id = await getMobileTaskInstanceId(secret, namespace, local);
    assert.equal(secret.values.get(taskKeys(namespace).current), id);
  });

  const failedLocals = [
    ["read throw", { loadLocalStorage() { throw new Error("LOCAL_LOCKED"); }, saveLocalStorage() { throw new Error("MUST_NOT_WRITE"); } }],
    ["read rejection", { async loadLocalStorage() { throw new Error("LOCAL_LOCKED"); }, async saveLocalStorage() { throw new Error("MUST_NOT_WRITE"); } }],
    ["write throw", { loadLocalStorage() { return null; }, saveLocalStorage() { throw new Error("LOCAL_FAILED"); } }],
    ["write rejection", { async loadLocalStorage() { return null; }, async saveLocalStorage() { throw new Error("LOCAL_FAILED"); } }],
    ["readback mismatch", { loadLocalStorage() { return null; }, saveLocalStorage() {} }],
    ["invalid UUID", { loadLocalStorage() { return "../foreign"; }, saveLocalStorage() { throw new Error("MUST_NOT_WRITE"); } }]
  ];
  for (const [name, local] of failedLocals) await test(`both stores unavailable with local ${name} rejects instead of inventing a usable identity`, async () => {
    const secret = { getSecret() { throw new Error("LOCKED"); }, setSecret() { throw new Error("MUST_NOT_WRITE"); } };
    await assert.rejects(getMobileTaskInstanceId(secret, "double-failure", local), /无法读取或确认保存/);
  });

  await test("local-only concurrency coalesces while Vaults and devices keep distinct identities", async () => {
    const deviceA = localFixture(); const deviceB = localFixture(); const local = asyncLocal(deviceA);
    const ids = await Promise.all(Array.from({ length: 30 }, () => getMobileTaskInstanceId(undefined, "vault-a", local)));
    assert.equal(new Set(ids).size, 1); assert.equal(deviceA.writes, 1);
    const vaultB = await getMobileTaskInstanceId(undefined, "vault-b", local);
    const otherDevice = await getMobileTaskInstanceId(undefined, "vault-a", asyncLocal(deviceB));
    assert.equal(new Set([ids[0], vaultB, otherDevice]).size, 3);
    await assert.rejects(getMobileTaskInstanceId(undefined, "  ", local), /不可用/);
  });

  await test("membership async ports confirm short-key state and device credentials before reporting persistence", async () => {
    const backing = strictSecret(); const secret = asyncSecret(backing); const namespace = "membership-fixture";
    const storage = await createMobileMembershipStorage(secret, namespace);
    assert.equal(storage.persistent, true); assert.deepEqual(plain(await storage.read()), {});
    const state = { token: "fixture-token", deviceId: "fixture-device" }; await storage.write(state);
    assert.deepEqual(plain(await storage.read()), state);
    const identities = await Promise.all(Array.from({ length: 10 }, () => storage.identity()));
    assert.equal(identities.every(value => value.publicKey.x === identities[0].publicKey.x), true);
    assert.equal(backing.writes.filter(key => key.endsWith("-identity")).length, 1);
    assert.equal(backing.writes.every(key => /^[a-z0-9-]{1,64}$/.test(key)), true);
    const restarted = strictSecret(); restarted.values = new Map(backing.values);
    const reopened = await createMobileMembershipStorage(asyncSecret(restarted), namespace);
    assert.equal(reopened.persistent, true); assert.deepEqual(plain(await reopened.read()), state);
    assert.deepEqual(plain(await reopened.identity()), plain(identities[0]));
  });

  await test("membership concurrent adapters share one persisted credential through awaited identity reads", async () => {
    const backing = strictSecret(); const secret = asyncSecret(backing);
    const a = await createMobileMembershipStorage(secret, "shared-membership");
    const b = await createMobileMembershipStorage(secret, "shared-membership");
    const [first, second] = await Promise.all([a.identity(), b.identity()]);
    assert.deepEqual(plain(first), plain(second)); assert.equal(backing.writes.filter(key => key.endsWith("-identity")).length, 1);
  });

  for (const [name, makeSecret] of failedSecrets) await test(`membership secret ${name} creates a session-only adapter without rejecting plugin setup`, async () => {
    const storage = await createMobileMembershipStorage(makeSecret(), "unavailable-membership");
    assert.equal(storage.persistent, false); assert.deepEqual(plain(await storage.read()), {});
    const state = { token: "session-only-token" }; await storage.write(state); state.token = "outside-change";
    assert.deepEqual(plain(await storage.read()), { token: "session-only-token" }); assert.equal(storage.persistent, false);
    const snapshot = await storage.read(); snapshot.token = "outside-read-change";
    assert.deepEqual(plain(await storage.read()), { token: "session-only-token" });
  });

  await test("membership later async write rejection clears persistence and retains prior credentials", async () => {
    const backing = strictSecret(); let fail = false;
    const secret = {
      async getSecret(key) { return backing.getSecret(key); },
      async setSecret(key, value) { if (fail) throw new Error("WRITE_FAILED"); backing.setSecret(key, value); }
    };
    const storage = await createMobileMembershipStorage(secret, "write-failure-membership");
    await storage.write({ token: "prior-token" }); const before = [...backing.values]; fail = true;
    await assert.rejects(storage.write({ token: "new-token" }), /未确认持久化/);
    assert.equal(storage.persistent, false); assert.deepEqual([...backing.values], before);
  });

  await test("membership async read failure and damaged credentials preserve old secret values", async () => {
    const backing = strictSecret(); const secret = asyncSecret(backing); const namespace = "damaged-membership";
    const storage = await createMobileMembershipStorage(secret, namespace); await storage.identity();
    const identityKey = [...backing.values.keys()].find(key => key.endsWith("-identity"));
    backing.values.set(identityKey, "{damaged-credential");
    const restarted = strictSecret(); restarted.values = new Map(backing.values);
    const reopened = await createMobileMembershipStorage(asyncSecret(restarted), namespace);
    await assert.rejects(reopened.identity(), /设备凭据不可读取/);
    assert.equal(restarted.values.get(identityKey), "{damaged-credential");
    secret.getSecret = async () => { throw new Error("READ_FAILED"); };
    await assert.rejects(storage.read(), /登录状态不可读取/); assert.equal(storage.persistent, false);
    assert.equal(backing.values.get(identityKey), "{damaged-credential");
  });

  console.log(`Mobile storage: ${passed} scenarios passed (memory fixtures; no native-device claim).`);
  return passed;
}
