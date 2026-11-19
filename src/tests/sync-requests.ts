import assert from "node:assert/strict";
import { CompanyService, type CompanyHost, type CompanyRecordStore } from "../company/service";
import { emptyCompanyDocument, normalizeCompanyDocument } from "../company/logic";
import type { CompanyDocument } from "../company/types";
import { SyncDeviceStore } from "../sync/device-store";
import { SyncRequestService, readRequestsFor } from "../sync/requests";
import { SYNC_DEVICES_DIR } from "../sync/types";
import { FakeSyncVault } from "./sync-fake-vault";

class MemoryStore implements CompanyRecordStore {
  private doc: CompanyDocument;
  private readonly listeners = new Set<() => void>();
  constructor(initial?: unknown) { this.doc = normalizeCompanyDocument(initial ?? emptyCompanyDocument()); }
  load(): Promise<CompanyDocument> { return Promise.resolve(this.doc); }
  snapshot(): CompanyDocument { return this.doc; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  mutate(change: (doc: CompanyDocument) => CompanyDocument): Promise<CompanyDocument> {
    this.doc = normalizeCompanyDocument(change(structuredClone(this.doc)));
    for (const listener of this.listeners) listener();
    return Promise.resolve(this.doc);
  }
}
function fakeHost(deviceId: string) {
  let clock = 1000, seq = 0;
  const running = new Set<string>(), turns: { id: string; text: string }[] = [], stopped: string[] = [];
  const host: CompanyHost = {
    now: () => ++clock, newId: prefix => `${prefix}-${deviceId}-${++seq}`,
    agents: () => [{ id: "sol", name: "总助", position: "", hired: true }, { id: "lin", name: "研究员", position: "", hired: true }],
    deviceId: () => deviceId, routerPermission: () => "workspace-write",
    createWorker: () => Promise.resolve(),
    startTurn: (id, text) => { running.add(id); turns.push({ id, text }); return Promise.resolve(); },
    isRunning: id => running.has(id), steer: () => Promise.resolve(false),
    stop: id => { running.delete(id); stopped.push(id); return Promise.resolve(); },
    lastAssistantText: () => Promise.resolve(undefined), setRouterMetadata: () => Promise.resolve(),
    ensureFolder: name => Promise.resolve(`项目/${name}`), latestUserText: () => Promise.resolve("x")
  };
  return { host, running, turns, stopped };
}
const timers = { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number, clearTimeout: (id: number) => clearTimeout(id),
  setInterval: (fn: () => void, ms: number) => setInterval(fn, ms) as unknown as number, clearInterval: (id: number) => clearInterval(id) };
const names: Record<string, string> = { "mac-a": "电脑", "phone-b": "iPhone", "pad-c": "iPad" };

/** Device A owns a project with one dispatch waiting for a decision (report at 500). */
const waitingDoc = () => ({ schemaVersion: 1,
  projects: [{ id: "p1", name: "项目", background: "", goal: "g", criteria: ["c"], folder: "项目/p", routerConversationId: "router-1", ownerDeviceId: "mac-a", status: "running",
    plan: [{ id: "t1", agentId: "lin", label: "查", brief: "查资料", dependsOn: [] }], roles: {}, createdAt: 1, startedAt: 2 }],
  dispatches: [{ id: "conv-1", routerConversationId: "router-1", projectId: "p1", planTaskId: "t1", agentId: "lin", ownerDeviceId: "mac-a", brief: "查资料", status: "waiting", permission: "workspace-write", createdAt: 3, startedAt: 4, endedAt: 500, turns: 1,
    report: { outcome: "need_decision", summary: "要选", question: "选哪个？", options: ["甲", "乙"], outputs: [], at: 500 } }],
  events: [] });

export async function runSyncRequestTests(): Promise<void> {
  let passed = 0, seq = 0;
  const ok = (name: string) => { passed++; console.log(`ok ${passed} - ${name}`); };
  const setup = async (doc: unknown = waitingDoc()) => {
    const fs = new FakeSyncVault(); let clock = 10_000;
    const now = () => ++clock;
    const ha = fakeHost("mac-a"), serviceA = new CompanyService(new MemoryStore(doc), ha.host);
    await serviceA.initialize();
    const mk = async (id: string, service: CompanyService) => {
      const device = new SyncDeviceStore({ fs, deviceId: id, deviceName: names[id], deviceKind: id.startsWith("mac") ? "desktop" : "phone", now });
      await device.open();
      return new SyncRequestService({ fs, device, service, deviceName: d => names[d] ?? d, now, newId: () => `req-${id}-${++seq}`, timers, debounceMs: 0 });
    };
    const hb = fakeHost("phone-b"), serviceB = new CompanyService(new MemoryStore(emptyCompanyDocument()), hb.host); await serviceB.initialize();
    const hc = fakeHost("pad-c"), serviceC = new CompanyService(new MemoryStore(emptyCompanyDocument()), hc.host); await serviceC.initialize();
    return { fs, now, ha, serviceA, a: await mk("mac-a", serviceA), b: await mk("phone-b", serviceB), c: await mk("pad-c", serviceC) };
  };

  {
    const t = await setup();
    const sent = await t.b.send({ kind: "answer_decision", targetDeviceId: "mac-a", dispatchId: "conv-1", projectId: "p1", reportAt: 500, answer: "甲" });
    assert.equal(t.fs.files.has(`${SYNC_DEVICES_DIR}/phone-b/requests/${sent.id}.json`), true, "the request lives in the requester's own folder");
    assert.equal(t.b.stateFor("conv-1", 500)?.status, "sent");
    // The owner is offline for a while: nothing happens until it scans.
    assert.equal(t.serviceA.dispatchOf("conv-1")?.status, "waiting");
    await t.a.scan();
    assert.equal(t.serviceA.dispatchOf("conv-1")?.answer, "甲", "the owner adopts the answer through answerDecision");
    assert.equal(t.ha.turns.length, 1, "the worker continues on the owner device");
    assert.ok(t.fs.files.has(`${SYNC_DEVICES_DIR}/mac-a/acks/${sent.id}.json`), "the ack lives in the executor's own folder");
    await t.b.scan();
    const state = t.b.stateFor("conv-1", 500);
    assert.equal(state?.status, "adopted");
    await t.a.scan();
    assert.equal(t.ha.turns.length, 1, "re-scanning never re-applies an acked request");
    const again = await setupReopen(t);
    await again.scan();
    assert.equal(t.ha.turns.length, 1, "after restart the ack file is the durable mark");
    ok("an answer from another device reaches the owner device, is adopted once, and the requester sees 已采纳");
  }

  {
    const t = await setup();
    const first = await t.b.send({ kind: "answer_decision", targetDeviceId: "mac-a", dispatchId: "conv-1", reportAt: 500, answer: "甲" });
    const second = await t.c.send({ kind: "answer_decision", targetDeviceId: "mac-a", dispatchId: "conv-1", reportAt: 500, answer: "乙" });
    const incoming = await readRequestsFor(t.fs, "mac-a");
    assert.deepEqual(incoming.map(r => r.id), [first.id, second.id], "older request first; clocks are not compared across devices");
    await t.a.scan();
    assert.equal(t.serviceA.dispatchOf("conv-1")?.answer, "甲", "only the first answer is adopted");
    await t.b.scan(); await t.c.scan();
    assert.equal(t.b.stateFor("conv-1", 500)?.status, "adopted");
    const lost = t.c.stateFor("conv-1", 500);
    assert.equal(lost?.status, "superseded");
    assert.match(lost?.status === "superseded" ? lost.ack.reason : "", /已被iPhone回答：甲/u);
    assert.equal(lost?.status === "superseded" ? lost.ack.adoptedDeviceId : "", "phone-b");
    ok("two answers for the same decision: one adopted, the other gets 已被别处回答");
  }

  {
    const t = await setup();
    // The task finished on its own before the answer arrived.
    await t.serviceA.stop("router-1", "conv-1");
    const sent = await t.b.send({ kind: "answer_decision", targetDeviceId: "mac-a", dispatchId: "conv-1", reportAt: 500, answer: "甲" });
    await t.a.scan(); await t.b.scan();
    assert.equal(t.b.stateFor("conv-1", 500)?.status, "rejected");
    const stale = await t.c.send({ kind: "answer_decision", targetDeviceId: "mac-a", dispatchId: "conv-9", reportAt: 1, answer: "x" });
    await t.a.scan(); await t.c.scan();
    assert.equal(t.c.sent().find(s => s.request.id === stale.id)?.status, "rejected", "unknown dispatch → rejected, never executed");
    assert.equal(t.b.sent().find(s => s.request.id === sent.id)?.status, "rejected");
    ok("answers for an ended or unknown task are rejected with a reason");
  }

  {
    const t = await setup();
    // An answer for an older round is rejected once the report changed.
    const sent = await t.b.send({ kind: "answer_decision", targetDeviceId: "mac-a", dispatchId: "conv-1", reportAt: 499, answer: "甲" });
    await t.a.scan(); await t.b.scan();
    const state = t.b.sent().find(s => s.request.id === sent.id);
    assert.equal(state?.status, "rejected");
    assert.match(state?.status === "rejected" ? state.ack.reason : "", /问题已更新/u);
    assert.equal(t.serviceA.dispatchOf("conv-1")?.answer, undefined);
    ok("an answer to an older round is not applied to the current question");
  }

  {
    const t = await setup({ ...waitingDoc(), dispatches: waitingDoc().dispatches.map(d => ({ ...d, status: "running", report: undefined, endedAt: undefined })) });
    t.ha.running.add("conv-1");
    const stop = await t.b.send({ kind: "stop_dispatch", targetDeviceId: "mac-a", dispatchId: "conv-1" });
    await t.a.scan(); await t.b.scan();
    assert.deepEqual(t.ha.stopped, ["conv-1"]);
    assert.equal(t.serviceA.dispatchOf("conv-1")?.status, "stopped");
    assert.equal(t.b.sent().find(s => s.request.id === stop.id)?.status, "adopted");
    const again = await t.c.send({ kind: "stop_dispatch", targetDeviceId: "mac-a", dispatchId: "conv-1" });
    await t.a.scan(); await t.c.scan();
    assert.equal(t.c.sent().find(s => s.request.id === again.id)?.status, "rejected", "stopping an ended task is rejected");
    // Requests aimed at another device are ignored here.
    await t.b.send({ kind: "stop_dispatch", targetDeviceId: "pad-c", dispatchId: "conv-1" });
    await t.a.scan();
    assert.equal([...t.fs.files.keys()].filter(key => key.includes("/mac-a/acks/")).length, 2, "A acks only what is addressed to A");
    ok("stop travels the same way; requests for other devices are left alone");
  }

  {
    const t = await setup();
    t.fs.files.set(`${SYNC_DEVICES_DIR}/phone-b/requests/req-broken.json`, "{\"schema\":\"echoink.sync.request.v1\",\"deviceId\":\"phone-b\",\"rev\":9,\"updatedAt\":1,\"payload\":{\"kind\":\"answer_decision\"");
    t.fs.files.set(`${SYNC_DEVICES_DIR}/phone-b/requests/req-copy 2.json`, JSON.stringify({ schema: "echoink.sync.request.v1", deviceId: "phone-b", rev: 9, updatedAt: 1, payload: { kind: "answer_decision", targetDeviceId: "mac-a", dispatchId: "conv-1", reportAt: 500, answer: "乙", createdAt: 1 } }));
    t.fs.files.set(`${SYNC_DEVICES_DIR}/pad-c/requests/req-forged.json`, JSON.stringify({ schema: "echoink.sync.request.v1", deviceId: "phone-b", rev: 9, updatedAt: 1, payload: { kind: "answer_decision", targetDeviceId: "mac-a", dispatchId: "conv-1", reportAt: 500, answer: "乙", createdAt: 1 } }));
    await t.a.scan();
    assert.equal(t.serviceA.dispatchOf("conv-1")?.answer, undefined, "half files, conflict copies and files whose deviceId does not match their folder are ignored");
    ok("damaged, duplicated or misplaced request files are never acted on");
  }
}

/** A fresh SyncRequestService over the same folder, as after a plugin restart. */
async function setupReopen(t: { fs: FakeSyncVault; now: () => number; serviceA: CompanyService }): Promise<SyncRequestService> {
  const device = new SyncDeviceStore({ fs: t.fs, deviceId: "mac-a", deviceName: "电脑", deviceKind: "desktop", now: t.now });
  await device.open();
  return new SyncRequestService({ fs: t.fs, device, service: t.serviceA, deviceName: id => names[id] ?? id, now: t.now, timers, debounceMs: 0 });
}
