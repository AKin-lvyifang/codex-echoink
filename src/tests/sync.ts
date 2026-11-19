import assert from "node:assert/strict";
import { CompanyService, type CompanyHost, type CompanyRecordStore } from "../company/service";
import { emptyCompanyDocument, normalizeCompanyDocument } from "../company/logic";
import type { CompanyDocument } from "../company/types";
import { resolveDesktopSyncDeviceId } from "../sync/device-id";
import { SyncDeviceStore } from "../sync/device-store";
import { CompanySyncMirror, COMPANY_MIGRATION_KEY } from "../sync/company-mirror";
import { readSyncCompanyArchive, readSyncCompanyOverview } from "../sync/company-view";
import { SYNC_DEVICES_DIR, SYNC_README, SYNC_SCHEMA } from "../sync/types";
import { FakeSyncVault } from "./sync-fake-vault";

/** In-memory company record, like the desktop/mobile stores but without a file. */
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

function fakeHost(deviceId?: string) {
  let clock = 1000, seq = 0;
  const running = new Set<string>(), turns: { id: string; text: string }[] = [], workers: string[] = [];
  const host: CompanyHost = {
    now: () => ++clock, newId: prefix => `${prefix}-${deviceId ?? "x"}-${++seq}`,
    agents: () => [{ id: "sol", name: "总助", position: "", hired: true }, { id: "generalist", name: "通才", position: "", hired: true }, { id: "lin", name: "研究员", position: "", hired: true }],
    ...(deviceId ? { deviceId: () => deviceId } : {}),
    routerPermission: () => "workspace-write",
    createWorker: input => { workers.push(input.id); return Promise.resolve(); },
    startTurn: (id, text) => { running.add(id); turns.push({ id, text }); return Promise.resolve(); },
    isRunning: id => running.has(id),
    steer: () => Promise.resolve(false),
    stop: id => { running.delete(id); return Promise.resolve(); },
    lastAssistantText: () => Promise.resolve(undefined),
    setRouterMetadata: () => Promise.resolve(),
    ensureFolder: name => Promise.resolve(`项目/${name}`),
    latestUserText: () => Promise.resolve("做一期视频")
  };
  return { host, running, turns, workers, settle: (id: string) => running.delete(id) };
}

const timers = { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number, clearTimeout: (id: number) => clearTimeout(id),
  setInterval: (fn: () => void, ms: number) => setInterval(fn, ms) as unknown as number, clearInterval: (id: number) => clearInterval(id) };
const device = (fs: FakeSyncVault, id: string, name: string, now: () => number) => new SyncDeviceStore({ fs, deviceId: id, deviceName: name, deviceKind: id.startsWith("mac") ? "desktop" : "phone", now });

export async function runSyncTests(): Promise<void> {
  let passed = 0;
  const ok = (name: string) => { passed++; console.log(`ok ${passed} - ${name}`); };

  {
    const local = new Map<string, unknown>();
    const port = { loadLocalStorage: (key: string) => local.get(key) ?? null, saveLocalStorage: (key: string, value: string) => { local.set(key, value); } };
    const first = await resolveDesktopSyncDeviceId(port);
    assert.equal(await resolveDesktopSyncDeviceId(port), first, "the id is created once and reused");
    assert.equal(local.size, 1);
    local.set("echoink-sync-device-id", "bad id with spaces");
    await assert.rejects(resolveDesktopSyncDeviceId(port), /损坏/u, "a damaged id is never overwritten with a new one");
    await assert.rejects(resolveDesktopSyncDeviceId({ loadLocalStorage: () => null, saveLocalStorage: () => { throw new Error("ro"); } }), /无法写入/u);
    ok("desktop device id lives in local storage, never in Vault files, and is not recreated over a damaged value");
  }

  {
    const fs = new FakeSyncVault(); let clock = 1_000;
    const a = device(fs, "mac-a", "方哥的 Mac", () => ++clock), b = device(fs, "phone-b", "方哥的 iPhone", () => ++clock);
    await a.open(); await b.open();
    assert.ok(fs.files.has(SYNC_README));
    const first = await a.write("company.json", SYNC_SCHEMA.company, { projects: [], dispatches: [], events: [] });
    const second = await a.write("company.json", SYNC_SCHEMA.company, { projects: [], dispatches: [], events: [] });
    await b.write("company.json", SYNC_SCHEMA.company, { projects: [], dispatches: [], events: [] });
    assert.equal(first.rev, 1); assert.equal(second.rev, 2);
    assert.deepEqual([...fs.files.keys()].filter(key => key.endsWith("company.json")).sort(), [`${SYNC_DEVICES_DIR}/mac-a/company.json`, `${SYNC_DEVICES_DIR}/phone-b/company.json`]);
    assert.equal((fs.json(`${SYNC_DEVICES_DIR}/phone-b/company.json`) as { deviceId: string }).deviceId, "phone-b");
    assert.ok(fs.writes.every(path => path.startsWith(`${SYNC_DEVICES_DIR}/mac-a/`) || path.startsWith(`${SYNC_DEVICES_DIR}/phone-b/`) || path === SYNC_README));
    const reopened = device(fs, "mac-a", "方哥的 Mac", () => ++clock); await reopened.open();
    assert.equal((await reopened.write("company.json", SYNC_SCHEMA.company, { projects: [], dispatches: [], events: [] })).rev, 3, "rev continues after restart");
    fs.failWrites = 1;
    await assert.rejects(reopened.write("company.json", SYNC_SCHEMA.company, { projects: [], dispatches: [], events: [] }), /disk full/u);
    assert.equal(reopened.currentRev, 3, "a failed write does not consume a rev");
    ok("single writer: each device writes only its own folder; rev is per device and survives restart");
  }

  const legacy = () => ({ schemaVersion: 1,
    projects: [
      { id: "p-run", name: "进行中的项目", background: "", goal: "做完", criteria: ["完成"], folder: "项目/进行中", routerConversationId: "router-1", status: "running", plan: [{ id: "t1", agentId: "lin", label: "查", brief: "查资料", dependsOn: [] }], roles: {}, createdAt: 1, startedAt: 2 },
      { id: "p-done", name: "结项的项目", background: "", goal: "做完", criteria: ["完成"], folder: "项目/结项", routerConversationId: "router-2", status: "done", plan: [], roles: {}, createdAt: 1, startedAt: 2, endedAt: 9, summary: "做完了" }
    ],
    dispatches: [
      { id: "conv-run", routerConversationId: "router-1", projectId: "p-run", planTaskId: "t1", agentId: "lin", brief: "查资料", status: "running", permission: "workspace-write", createdAt: 3, startedAt: 4, turns: 1 },
      { id: "conv-done", routerConversationId: "router-2", projectId: "p-done", agentId: "lin", brief: "旧活", status: "done", permission: "workspace-write", createdAt: 3, turns: 1 }
    ],
    events: [{ id: "e1", projectId: "p-run", kind: "goal", who: "sol", text: "目标", at: 2 }, { id: "e2", projectId: "p-done", kind: "close", who: "sol", text: "结项", at: 9 }] });

  {
    const fs = new FakeSyncVault(); let clock = 1_000;
    const store = new MemoryStore(legacy());
    const mirror = new CompanySyncMirror({ device: device(fs, "mac-a", "Mac", () => ++clock), store, now: () => ++clock, debounceMs: 0, timers });
    const started = await mirror.start();
    assert.equal(started.status, "ready"); assert.equal(started.status === "ready" && started.migrated, true);
    const company = fs.json(`${SYNC_DEVICES_DIR}/mac-a/company.json`) as { schema: string; payload: { projects: { id: string }[]; dispatches: { id: string }[]; events: unknown[] } };
    assert.equal(company.schema, SYNC_SCHEMA.company);
    assert.deepEqual(company.payload.projects.map(p => p.id), ["p-run"], "only unfinished projects stay in company.json");
    assert.deepEqual(company.payload.dispatches.map(d => d.id), ["conv-run"]);
    assert.equal(company.payload.events.length, 1);
    const archive = fs.json(`${SYNC_DEVICES_DIR}/mac-a/company-archive/p-done.json`) as { payload: { project: { id: string }; dispatches: unknown[] } };
    assert.equal(archive.payload.project.id, "p-done"); assert.equal(archive.payload.dispatches.length, 1);
    const deviceFile = fs.json(`${SYNC_DEVICES_DIR}/mac-a/device.json`) as { payload: { migration: Record<string, unknown>; name: string } };
    assert.ok(deviceFile.payload.migration[COMPANY_MIGRATION_KEY]); assert.equal(deviceFile.payload.name, "Mac");
    mirror.stop();
    // Re-entrant: a second start on the same source rewrites the same files and does not migrate again.
    const writesBefore = fs.writes.length;
    const again = new CompanySyncMirror({ device: device(fs, "mac-a", "Mac", () => ++clock), store, now: () => ++clock, debounceMs: 0, timers });
    const restarted = await again.start();
    assert.equal(restarted.status === "ready" && restarted.migrated, false, "same source → no second migration");
    assert.equal([...fs.files.keys()].filter(key => key.includes("company-archive")).length, 1, "the archive is not duplicated");
    assert.ok(fs.writes.length > writesBefore);
    // Live change: a new dispatch is mirrored after the store changes.
    await store.mutate(doc => ({ ...doc, dispatches: [...doc.dispatches, { id: "conv-new", routerConversationId: "router-1", projectId: "p-run", agentId: "lin", brief: "新活", status: "queued", permission: "workspace-write", createdAt: 5, turns: 0 }] }));
    await again.flush();
    assert.deepEqual((fs.json(`${SYNC_DEVICES_DIR}/mac-a/company.json`) as { payload: { dispatches: { id: string }[] } }).payload.dispatches.map(d => d.id), ["conv-run", "conv-new"]);
    // Finishing a project moves it to the archive and out of company.json.
    await store.mutate(doc => ({ ...doc, projects: doc.projects.map(p => p.id === "p-run" ? { ...p, status: "done", endedAt: 20 } : p) }));
    await again.flush();
    assert.deepEqual((fs.json(`${SYNC_DEVICES_DIR}/mac-a/company.json`) as { payload: { projects: unknown[] } }).payload.projects, []);
    assert.ok(fs.files.has(`${SYNC_DEVICES_DIR}/mac-a/company-archive/p-run.json`));
    assert.equal((await readSyncCompanyArchive(fs, "mac-a")).length, 2);
    again.stop();
    ok("migration copies the legacy record (active → company.json, finished → archive), is re-entrant, and live changes follow");
  }

  {
    const fs = new FakeSyncVault(); let clock = 1_000;
    const store = new MemoryStore(legacy());
    fs.failWrites = 2;
    const mirror = new CompanySyncMirror({ device: device(fs, "mac-a", "Mac", () => ++clock), store, now: () => ++clock, debounceMs: 0, timers });
    const failed = await mirror.start();
    assert.equal(failed.status, "failed");
    assert.equal(fs.files.has(`${SYNC_DEVICES_DIR}/mac-a/company.json`), false, "nothing half-migrated is reported as done");
    assert.deepEqual(store.snapshot().projects.map(p => p.id), ["p-run", "p-done"], "the runtime record is untouched");
    await store.mutate(doc => doc);
    await mirror.flush();
    assert.equal(fs.files.has(`${SYNC_DEVICES_DIR}/mac-a/company.json`), false, "a failed start leaves no subscription behind");
    const retry = await new CompanySyncMirror({ device: device(fs, "mac-a", "Mac", () => ++clock), store, now: () => ++clock, debounceMs: 0, timers }).start();
    assert.equal(retry.status, "ready");
    assert.ok(fs.files.has(`${SYNC_DEVICES_DIR}/mac-a/company.json`));
    ok("a failed migration keeps the old storage as is and succeeds on the next start");
  }

  {
    const fs = new FakeSyncVault(); let clock = 1_000;
    const a = new CompanySyncMirror({ device: device(fs, "mac-a", "方哥的 Mac", () => ++clock), store: new MemoryStore(legacy()), now: () => ++clock, debounceMs: 0, timers });
    assert.equal((await a.start()).status, "ready");
    const b = device(fs, "phone-b", "方哥的 iPhone", () => ++clock); await b.open();
    // Conflict copies and half-synced files are ignored.
    fs.files.set(`${SYNC_DEVICES_DIR}/mac-a/company 2.json`, JSON.stringify({ schema: SYNC_SCHEMA.company, deviceId: "mac-a", rev: 99, updatedAt: 1, payload: { projects: [{ id: "ghost", name: "幽灵", routerConversationId: "r", status: "running", plan: [], roles: {}, createdAt: 1 }], dispatches: [], events: [] } }));
    fs.folders.add(`${SYNC_DEVICES_DIR}/half-c`);
    fs.files.set(`${SYNC_DEVICES_DIR}/half-c/device.json`, '{"schema":"echoink.sync.device.v1","deviceId":"half-c","rev":1,"updatedAt":1,"payload":{"name":"半截"');
    fs.files.set(`${SYNC_DEVICES_DIR}/half-c/company.json`, "{");
    const overview = await readSyncCompanyOverview(fs, "phone-b", clock);
    assert.deepEqual(overview.devices.map(d => [d.id, d.name, d.isSelf, d.online]), [["mac-a", "方哥的 Mac", false, true], ["phone-b", "方哥的 iPhone", true, true]]);
    assert.deepEqual(overview.projects.map(p => [p.id, p.deviceId, p.deviceName, p.ownerDeviceId]), [["p-run", "mac-a", "方哥的 Mac", "mac-a"]]);
    assert.deepEqual(overview.dispatches.map(d => [d.id, d.status, d.ownerDeviceId]), [["conv-run", "running", "mac-a"]]);
    assert.equal(overview.docs["mac-a"].projects[0].name, "进行中的项目");
    assert.equal(overview.docs["phone-b"], undefined, "self is never in the remote view");
    const stale = await readSyncCompanyOverview(fs, "phone-b", clock + 10 * 60_000);
    assert.equal(stale.devices[0].online, false);
    a.stop();
    ok("read-only overview: other devices' projects carry the device name; self, conflict copies and half files are ignored");
  }

  {
    // Hard acceptance: a "running" dispatch that arrived through sync is never executed here.
    const fs = new FakeSyncVault(); let clock = 1_000;
    const a = new CompanySyncMirror({ device: device(fs, "mac-a", "Mac", () => ++clock), store: new MemoryStore(legacy()), now: () => ++clock, debounceMs: 0, timers });
    assert.equal((await a.start()).status, "ready");
    const overview = await readSyncCompanyOverview(fs, "phone-b", clock);
    // 1) Structural: device B builds its service from its own record only. The overview is for reading.
    const hb = fakeHost("phone-b");
    const serviceB = new CompanyService(new MemoryStore(emptyCompanyDocument()), hb.host);
    await serviceB.initialize();
    assert.equal(hb.turns.length, 0); assert.equal(serviceB.doc.dispatches.length, 0);
    assert.equal(overview.dispatches.length, 1, "B can see A's running dispatch");
    // 2) Belt and braces: even if another device's record lands in B's own store (iCloud copying the old file), B skips it.
    const leaked = { ...legacy(), projects: legacy().projects.map(p => ({ ...p, ownerDeviceId: "mac-a" })), dispatches: legacy().dispatches.map(d => ({ ...d, ownerDeviceId: "mac-a" })) };
    const hb2 = fakeHost("phone-b");
    const leakedB = new CompanyService(new MemoryStore(leaked), hb2.host);
    await leakedB.initialize();
    assert.equal(hb2.turns.length, 0, "no turn starts for another device's dispatch");
    assert.equal(leakedB.dispatchOf("conv-run")?.status, "running", "the foreign record is left as it was, not requeued");
    assert.equal(await leakedB.start("router-1", "p-run"), "这个项目属于另一台设备，只能在那台设备上开工。");
    await leakedB.answerDecision("conv-run", "x");
    assert.equal(leakedB.dispatchOf("conv-run")?.answer, undefined);
    // 3) The same record on its owner device is requeued and started as before.
    const ha = fakeHost("mac-a");
    const serviceA = new CompanyService(new MemoryStore(leaked), ha.host);
    await serviceA.initialize();
    assert.equal(ha.turns.length, 1); assert.equal(ha.turns[0].id, "conv-run");
    // 4) Legacy records without an owner are stamped with this device and keep running.
    const hl = fakeHost("mac-a");
    const stamped = new CompanyService(new MemoryStore(legacy()), hl.host);
    await stamped.initialize();
    assert.equal(stamped.projectOf("p-run")?.ownerDeviceId, "mac-a"); assert.equal(stamped.dispatchOf("conv-run")?.ownerDeviceId, "mac-a");
    assert.equal(hl.turns.length, 1);
    // 5) New work created here is stamped with this device.
    await stamped.dispatch("router-9", { agentId: "lin", moduleId: "none", brief: "新活" });
    assert.equal(stamped.doc.dispatches.at(-1)?.ownerDeviceId, "mac-a");
    await stamped.propose("router-8", { name: "新项目", background: "", goal: "g", criteria: ["c"], roles: {}, plan: [{ id: "t", agentId: "lin", moduleId: "none", label: "查", brief: "查", dependsOn: [] }] });
    assert.equal(stamped.doc.projects.at(-1)?.ownerDeviceId, "mac-a");
    a.stop();
    ok("a synced 'running' dispatch is never executed on another device; owner device behaviour is unchanged");
  }
}
