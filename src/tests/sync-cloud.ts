import { cloudFailureText, CLOUD_FAILURE_TEXT } from "../sync/cloud/messages";
import assert from "node:assert/strict";
import { CloudSyncClient, CloudApiError, CloudNetworkError, cloudRetryDelay, type CloudChange, type CloudCommitStatus, type CloudFileRef, type CloudLiveHandlers, type CloudSyncClientPort } from "../sync/cloud/client";
import { PBKDF2_ITERATIONS, deriveMasterKey, decryptEntry, encryptEntry, sha256Hex, type SyncMasterKey } from "../sync/cloud/crypto";
import { CloudSyncEngine, type CloudBasePort, type CloudFs, type CloudStatePort } from "../sync/cloud/engine";
import { conflictCopyPath, threeWayMerge } from "../sync/cloud/merge";
import { CloudSyncController } from "../sync/cloud/controller";
import { noteSyncIndicator, vaultSyncIndicator } from "../sync/cloud/status-indicators";
import { normalizeCloudSyncSettings } from "../sync/cloud/settings";
import { SYNC_DEVICES_DIR } from "../sync/types";
import { FakeSyncVault } from "./sync-fake-vault";

/** In-memory sync-service with the same rules as echoink-web/sync-service (cursor, per-device rev idempotency, quota, push). */
export class FakeCloud {
  cursor = 0; keyEpoch = 0; used = 0; quota = 1024 * 1024 * 1024; offline = false; readOnly = false; smallLimit = 65_536;
  /** Serve put-batch like the current service; false mimics an older service (404). */
  batch = true;
  readonly files = new Map<string, { deviceId: string; path: string; rev: number; size: number; sha256: string; deleted: boolean; cursor: number; bytes: Uint8Array | null; meta?: string }>();
  readonly objects = new Map<string, Uint8Array>();
  readonly live = new Map<string, CloudLiveHandlers>();
  readonly devices = new Map<string, string>();
  calls: string[] = [];
  private deviceList() { return [...this.devices].map(([deviceId, name]) => ({ deviceId, name, kind: "desktop", lastSeenAt: 0 })); }
  private key(deviceId: string, path: string) { return `${deviceId}\0${path}`; }
  private guard(name: string) { this.calls.push(name); if (this.offline) throw new CloudNetworkError(); }
  private commitOne(deviceId: string, file: { path: string; rev: number; size: number; sha256: string; deleted?: boolean; meta?: string }, bytes: Uint8Array | null): CloudCommitStatus {
    const existing = this.files.get(this.key(deviceId, file.path));
    if (existing && existing.rev === file.rev) return "already";
    if (existing && existing.rev > file.rev) return "stale";
    const size = file.deleted ? 0 : file.size, delta = size - (existing?.size ?? 0);
    if (delta > 0 && this.used + delta > this.quota) throw new CloudApiError("QUOTA_EXCEEDED", 413, { usedBytes: this.used, quotaBytes: this.quota });
    this.cursor += 1; this.used += delta;
    this.files.set(this.key(deviceId, file.path), { deviceId, path: file.path, rev: file.rev, size, sha256: file.sha256, deleted: !!file.deleted, cursor: this.cursor, bytes, ...(file.meta ? { meta: file.meta } : {}) });
    for (const [id, handlers] of this.live) if (id !== deviceId) handlers.onCursor(this.cursor);
    return "committed";
  }
  client(deviceId: string): CloudSyncClientPort {
    const cloud = this;
    return {
      register: async input => { cloud.guard("register"); cloud.devices.set(deviceId, input.name); return { deviceId, userId: "u", cursor: cloud.cursor, usedBytes: cloud.used, quotaBytes: cloud.quota, readOnly: cloud.readOnly, status: "active", graceUntil: null, keyEpoch: cloud.keyEpoch, smallFileLimit: cloud.smallLimit, devices: cloud.deviceList() }; },
      usage: async () => { cloud.guard("usage"); return { usedBytes: cloud.used, quotaBytes: cloud.quota, cursor: cloud.cursor, status: "active", readOnly: cloud.readOnly, graceUntil: null, keyEpoch: cloud.keyEpoch, devices: cloud.deviceList() }; },
      changes: async since => { cloud.guard("changes"); const all = [...cloud.files.values()].filter(f => f.cursor > since).sort((a, b) => a.cursor - b.cursor); const page = all.slice(0, 3);
        return { changes: page.map(f => ({ deviceId: f.deviceId, path: f.path, rev: f.rev, size: f.size, sha256: f.sha256, deleted: f.deleted, cursor: f.cursor, ...(f.meta ? { meta: f.meta } : {}) } satisfies CloudChange)), next: page.length ? page[page.length - 1].cursor : since, more: all.length > 3, cursor: cloud.cursor, keyEpoch: cloud.keyEpoch }; },
      putSmall: async file => { cloud.guard("putSmall"); if (cloud.readOnly) throw new CloudApiError("SYNC_READ_ONLY", 403); if (file.content.length > cloud.smallLimit) throw new CloudApiError("SIZE_MISMATCH", 400); return { status: cloud.commitOne(deviceId, file, file.content), cursor: cloud.cursor, usedBytes: cloud.used }; },
      putBatch: async files => { cloud.guard("putBatch"); if (!cloud.batch) throw new CloudApiError("NOT_FOUND", 404); if (cloud.readOnly) throw new CloudApiError("SYNC_READ_ONLY", 403);
        const results = files.map(file => ({ path: file.path, rev: file.rev, status: cloud.commitOne(deviceId, file, file.content) })); return { cursor: cloud.cursor, usedBytes: cloud.used, results }; },
      uploadUrls: async (files: readonly CloudFileRef[]) => { cloud.guard("uploadUrls"); if (cloud.readOnly) throw new CloudApiError("SYNC_READ_ONLY", 403); let projected = cloud.used;
        return files.map(f => { const existing = cloud.files.get(cloud.key(deviceId, f.path)); if (existing && existing.rev >= f.rev) return { path: f.path, rev: f.rev, status: "stale" as const }; projected += f.size - (existing?.size ?? 0); if (projected > cloud.quota) throw new CloudApiError("QUOTA_EXCEEDED", 413, { usedBytes: cloud.used, quotaBytes: cloud.quota }); return { path: f.path, rev: f.rev, status: "upload" as const, url: `obj://${deviceId}/${f.path}@${f.rev}` }; }); },
      putObject: async (url, bytes) => { cloud.guard("putObject"); cloud.objects.set(url, bytes); },
      commit: async files => { cloud.guard("commit"); if (cloud.readOnly) throw new CloudApiError("SYNC_READ_ONLY", 403);
        const results = await Promise.all(files.map(async f => { if ("deleted" in f) return { path: f.path, rev: f.rev, status: cloud.commitOne(deviceId, { path: f.path, rev: f.rev, size: 0, sha256: "", deleted: true }, null) };
          const bytes = cloud.objects.get(`obj://${deviceId}/${f.path}@${f.rev}`); if (!bytes) throw new CloudApiError("OBJECT_MISSING", 409); return { path: f.path, rev: f.rev, status: cloud.commitOne(deviceId, { path: f.path, rev: f.rev, size: bytes.length, sha256: await sha256Hex(bytes), ...("meta" in f && f.meta ? { meta: f.meta } : {}) }, bytes) }; }));
        return { cursor: cloud.cursor, usedBytes: cloud.used, results }; },
      downloadUrls: async files => { cloud.guard("downloadUrls"); return files.map(f => { const row = cloud.files.get(cloud.key(f.deviceId, f.path)); if (!row || row.deleted || row.rev !== f.rev || !row.bytes) return { ...f, status: "missing" as const };
        if (row.size <= cloud.smallLimit) { let s = ""; for (const b of row.bytes) s += String.fromCharCode(b); return { ...f, status: "inline" as const, content: btoa(s) }; } return { ...f, status: "download" as const, url: `obj://${f.deviceId}/${f.path}@${f.rev}` }; }); },
      getObject: async url => { cloud.guard("getObject"); const bytes = cloud.objects.get(url); if (!bytes) throw new CloudApiError("OBJECT_GET_FAILED", 404); return bytes; },
      reset: async () => { cloud.guard("reset"); cloud.files.clear(); cloud.objects.clear(); cloud.used = 0; cloud.keyEpoch += 1; cloud.cursor += 1; return { cursor: cloud.cursor, keyEpoch: cloud.keyEpoch }; },
      revokeDevice: async () => { cloud.guard("revoke"); },
      live: (id, handlers) => { cloud.live.set(id, handlers); handlers.onOpen(cloud.cursor, cloud.keyEpoch); return { close: () => { cloud.live.delete(id); } }; }
    };
  }
  /** Fix the sha256 of every stored row the way the real service does (from the blob). */
  async settle(): Promise<void> { for (const row of this.files.values()) if (row.bytes && !row.sha256) row.sha256 = await sha256Hex(row.bytes); }
}

/** FakeSyncVault plus binary access; each device gets its own Vault. */
export class DeviceVault extends FakeSyncVault implements CloudFs {
  readonly binaries = new Map<string, Uint8Array>();
  /** Edit times for conflict tests; unset paths report 0 like the plain fake vault. */
  readonly mtimes = new Map<string, number>();
  override async stat(path: string) { const stat = await super.stat(path); return stat && stat.type === "file" && this.mtimes.has(path) ? { ...stat, mtime: this.mtimes.get(path)! } : stat; }
  async readBinary(path: string): Promise<ArrayBuffer> {
    if (!this.files.has(path)) throw new Error(`Missing ${path}`);
    const bytes = this.files.get(path) === "[binary]" ? this.binaries.get(path) : undefined;
    return bytes ? new Uint8Array(bytes).buffer : new TextEncoder().encode(await this.read(path)).buffer as ArrayBuffer;
  }
  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    if (/\.(?:md|txt|json|jsonl|canvas|base|csv)$/iu.test(path)) { this.binaries.delete(path); await this.write(path, new TextDecoder().decode(data)); }
    else { await this.write(path, "[binary]"); this.binaries.set(path, new Uint8Array(data).slice()); }
  }
}
export const memoryState = (): CloudStatePort & { value: unknown } => { const port = { value: null as unknown, load: () => port.value, save: (value: unknown) => { port.value = value; } }; return port; };
export const memoryBase = (): CloudBasePort & { map: Map<string, string> } => { const map = new Map<string, string>(); return { map, read: async p => map.get(p) ?? null, write: async (p, t) => { map.set(p, t); }, remove: async p => { map.delete(p); } }; };
export const timers = { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number, clearTimeout: (id: number) => clearTimeout(id), setInterval: (fn: () => void, ms: number) => setInterval(fn, ms) as unknown as number, clearInterval: (id: number) => clearInterval(id) };

export async function runSyncCloudTests(): Promise<void> {
  for (const code of Object.keys(CLOUD_FAILURE_TEXT)) {
    assert.ok(/[\u4e00-\u9fff]/.test(cloudFailureText(code, true)));
    assert.ok(!/[\u4e00-\u9fff]/.test(cloudFailureText(code, false)));
  }
  assert.ok(!cloudFailureText(new Error("ECONNREFUSED secret=DO_NOT_SHOW"),false).includes("secret"));

  {
    const sent: string[] = [], pages: unknown[] = [], cursors: number[] = [];
    const socket = { send: (s: string) => { sent.push(s); }, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null } as unknown as WebSocket;
    const client = new CloudSyncClient({ requestsPerMinute: 60_000_000, apiUrl: "https://fixture.invalid", token: () => "synthetic-token", deviceId: "mac-a", transport: {
      websocket: () => socket, json: async () => { throw new Error("no HTTP for parser test"); }, putBytes: async () => 200, getBytes: async () => ({ status: 200, bytes: new Uint8Array() })
    } });
    client.live("mac-a", { onChanges: p => { pages.push(p); }, onCursor: c => { cursors.push(c); }, onOpen() {}, onClose() {} });
    socket.onopen!({} as Event); assert.equal(JSON.parse(sent[0]!).pushChanges, true);
    const emit = (data: unknown) => socket.onmessage!({ data: JSON.stringify(data) } as MessageEvent);
    emit({ type: "cursor", cursor: 1 }); assert.deepEqual(cursors, [1], "old server falls back to HTTP cursor");
    const page = { type: "cursor", cursor: 2, fromCursor: 1, keyEpoch: 0, changes: [{ deviceId: "phone-b", path: "opaque", rev: 1, size: 0, sha256: "", deleted: true, cursor: 2 }] };
    emit(page); assert.equal(pages.length, 1);
    emit({ ...page, cursor: 3 }); assert.deepEqual(cursors, [1, 3], "incomplete batches must catch up from the manifest");
    console.log("PASS optional live changes and old-server/incomplete-frame fallback");
  }

  let passed = 0;
  const ok = (name: string) => { passed++; console.log(`ok ${passed} - ${name}`); };
  {
    const cases = [
      { body: { error: "RATE_LIMITED", retryAfter: 230 }, header: "18", delay: 230_000 },
      { body: { retryAfter: -1 }, header: "18", delay: 18_000 },
      { body: null, header: "invalid", delay: 1_000 }
    ];
    for (const { body, header, delay } of cases) {
      const client = new CloudSyncClient({ requestIntervalMs: 0, apiUrl: "https://fixture.invalid", token: () => "synthetic-token", deviceId: "mac-a", transport: {
        json: async () => ({ status: 429, body, headers: { "Retry-After": header } }),
        putBytes: async () => 200, getBytes: async () => ({ status: 200, bytes: new Uint8Array() })
      } });
      await assert.rejects(client.usage(), error => error instanceof CloudApiError && error.status === 429 && cloudRetryDelay(error, 1_000) === delay);
    }
    ok("429 retry delay prefers valid body seconds, then case-insensitive header, then local backoff");
  }
  {
    const calls: { url: string; method: string; body: any }[] = [];
    const client = new CloudSyncClient({ requestsPerMinute: 60_000_000, apiUrl: "https://fixture.invalid", token: () => "synthetic-token", deviceId: "mac-a", transport: {
      json: async (url, method, body) => { calls.push({ url, method, body }); return { status: 200, body: {}, headers: {} }; },
      putBytes: async () => 200, getBytes: async () => ({ status: 200, bytes: new Uint8Array() })
    } });
    await client.commit([{ path: "test", rev: 2, deleted: true }]);
    assert.deepEqual(calls[0].body.files, [{ path: "test", rev: 2, deleted: true, size: 0 }]);
    await client.revokeDevice("other/device");
    assert.equal(calls[1].url, "https://fixture.invalid/api/devices/other%2Fdevice");
    assert.equal(calls[1].method, "DELETE");
    ok("client: tombstone size is normalized and device removal uses membership API");
  }
  {
    const devices = [{ deviceId: "mac-a", name: "Mac", kind: "desktop", lastSeenAt: 0 }, { deviceId: "phone-b", name: "Phone", kind: "phone", lastSeenAt: 0 }];
    let accountCount = 2, removes = 0;
    const controller = new CloudSyncController({ fs: new DeviceVault(), transport: { json: async () => ({ status: 500, body: null, headers: {} }), putBytes: async () => 500, getBytes: async () => ({ status: 500, bytes: new Uint8Array() }) },
      deviceId: "mac-a", deviceKind: "desktop", defaultDeviceName: "Mac", session: () => ({ apiUrl: "https://fixture.invalid", token: "t", accountId: "test", passwordSet: true, deviceId: "mac-a" }),
      settings: () => ({ enabled: false, excludedFolders: [], includeAttachments: false, deviceName: "" }), saveSettings: async () => {}, local: { load: () => null, save: () => {} }, base: memoryBase(),
      clientFactory: () => ({ usage: async () => ({ devices }), revokeDevice: async () => { throw new Error("must reuse account action"); } } as unknown as CloudSyncClientPort),
      removeDevice: async id => { removes++; const index = devices.findIndex(d => d.deviceId === id); if (index >= 0) devices.splice(index, 1); accountCount = devices.length; }
    });
    await controller.refreshDevices(); assert.equal(controller.view().devices.length, 2);
    await controller.revokeDevice("phone-b"); assert.equal(accountCount, 1); assert.equal(controller.view().devices.length, 1);
    await controller.revokeDevice("phone-b"); assert.equal(removes, 2); assert.equal(controller.view().devices.length, 1);
    controller.dispose(); ok("controller: account action refreshes both views and repeated removal stays successful");
  }
  const key = await deriveMasterKey("方哥的密码", "u-1", 1_000);
  const wrongKey = await deriveMasterKey("别的密码", "u-1", 1_000);
  const scope = { excludedFolders: [], includeAttachments: false };
  const device = (cloud: FakeCloud, id: string, name: string, k: SyncMasterKey = key, folders = scope) => {
    const fs = new DeviceVault(), state = memoryState(), base = memoryBase();
    const engine = new CloudSyncEngine({ fs, client: cloud.client(id), key: k, deviceId: id, deviceName: name, deviceKind: "desktop", scope: () => folders, state, base, timers, debounceMs: 0, now: () => 1_700_000_000_000 });
    return { fs, state, base, engine, write: (path: string, text: string) => fs.files.set(path, text), read: (path: string) => fs.files.get(path) };
  };
  // Hash rows like the real service would once a blob is stored, so the engine's hash check passes.
  const settle = (cloud: FakeCloud) => cloud.settle();

  {
    assert.equal(PBKDF2_ITERATIONS, 600_000);
    const blob = await encryptEntry(key, "笔记/a.md", new TextEncoder().encode("你好"));
    const open = await decryptEntry(key, blob);
    assert.equal(open.path, "笔记/a.md"); assert.equal(new TextDecoder().decode(open.body), "你好");
    assert.ok(!new TextDecoder().decode(blob).includes("笔记"), "the path is not visible in the ciphertext");
    await assert.rejects(decryptEntry(wrongKey, blob), /DECRYPT/u);
    blob[blob.length - 1] ^= 1;
    await assert.rejects(decryptEntry(key, blob), /DECRYPT|损坏/u, "a flipped byte is detected, never written");
    const again = await deriveMasterKey("方哥的密码", "u-1", 1_000);
    assert.equal(again.fingerprint, key.fingerprint); assert.notEqual(wrongKey.fingerprint, key.fingerprint);
    ok("encryption: path and body sealed per file, wrong password or damage fails closed");
  }

  {
    const base = "第一段\n\n第二段\n\n第三段";
    assert.deepEqual(threeWayMerge(base, "第一段改了\n\n第二段\n\n第三段", "第一段\n\n第二段\n\n第三段改了"), { ok: true, text: "第一段改了\n\n第二段\n\n第三段改了" }, "different paragraphs merge");
    assert.deepEqual(threeWayMerge(base, "第一段\n\n第二段 A\n\n第三段", "第一段\n\n第二段 B\n\n第三段").ok, false, "the same paragraph is a conflict");
    assert.deepEqual(threeWayMerge(base, base, "x"), { ok: true, text: "x" }); assert.deepEqual(threeWayMerge(base, "y", base), { ok: true, text: "y" });
    assert.deepEqual(threeWayMerge(base, "第一段\n\n第二段\n\n第三段\n\n第四段", "新开头\n\n第一段\n\n第二段\n\n第三段"), { ok: true, text: "新开头\n\n第一段\n\n第二段\n\n第三段\n\n第四段" }, "additions at both ends combine");
    assert.match(conflictCopyPath("笔记/a.md", "iPhone", 1_700_000_000_000), /^笔记\/a \(冲突 iPhone \d\d-\d\d \d\d-\d\d-\d\d\)\.md$/u);
    ok("three-way merge: separate edits combine, overlapping edits conflict");
  }

  {
    const cloud = new FakeCloud();
    const a = device(cloud, "mac-a", "Mac"), b = device(cloud, "phone-b", "iPhone");
    a.write(`${SYNC_DEVICES_DIR}/mac-a/company.json`, "{\"a\":1}"); a.write("笔记/日记.md", "今天\n\n天气好");
    await a.engine.start(); await settle(cloud);
    assert.equal(a.engine.snapshot().phase, "idle"); assert.equal(a.engine.snapshot().live, true);
    assert.ok([...cloud.files.values()].every(f => !f.path.includes("笔记") && !f.path.includes("company")), "the service sees path tokens only");
    await b.engine.start(); await settle(cloud); await b.engine.flush();
    assert.equal(b.read(`${SYNC_DEVICES_DIR}/mac-a/company.json`), "{\"a\":1}", "A's mirror arrives on B");
    assert.equal(b.read("笔记/日记.md"), "今天\n\n天气好", "the note arrives on B");
    // A types: live push brings it to B without polling.
    const seen: string[] = [], offA = a.engine.subscribe(() => { const s = a.engine.snapshot(); if (s.activePath) seen.push(`A ${s.activeDirection} ${s.activePath}`); });
    const offB = b.engine.subscribe(() => { const s = b.engine.snapshot(); if (s.activePath) seen.push(`B ${s.activeDirection} ${s.activePath}`); });
    a.write("笔记/日记.md", "今天\n\n天气好\n\n晚上吃面"); a.engine.noteVaultChange("笔记/日记.md", "modify");
    assert.equal(a.engine.hasPending("笔记/日记.md"), true, "an edited note waits for upload");
    assert.equal(a.engine.tracks("笔记/日记.md"), true);
    await a.engine.flush(); await settle(cloud); await b.engine.flush();
    assert.equal(b.read("笔记/日记.md"), "今天\n\n天气好\n\n晚上吃面");
    assert.equal(a.engine.hasPending("笔记/日记.md"), false);
    assert.ok(seen.includes("A up 笔记/日记.md") && seen.includes("B down 笔记/日记.md"), `the transferred note is reported: ${seen.join(", ")}`);
    assert.equal(a.engine.snapshot().activePath, null, "idle clears the active note"); offA(); offB();
    {
      const view = (phase: "idle" | "syncing" | "offline", activePath: string | null = null) => ({ enabled: true, signedIn: true, passwordSet: true, deviceReady: true, keyReady: true, devices: [],
        status: { ...a.engine.snapshot(), phase, activePath, activeDirection: activePath ? "up" as const : null, pending: phase === "offline" ? 2 : 0 } });
      const ports = (pending = false) => ({ tracks: () => true, pending: () => pending });
      assert.equal(vaultSyncIndicator(view("syncing", "笔记/日记.md"), true)?.text, "正在同步 · 日记.md");
      assert.equal(vaultSyncIndicator(view("offline"), true)?.text, "离线 · 2 个改动待上传");
      assert.equal(vaultSyncIndicator(view("offline"), true)?.warn, true);
      assert.equal(vaultSyncIndicator({ ...view("idle"), enabled: false }, true), null, "no status bar item while sync is off");
      assert.equal(noteSyncIndicator(view("syncing", "笔记/日记.md"), "笔记/日记.md", ports(), true)?.icon, "cloud-upload");
      assert.equal(noteSyncIndicator(view("syncing", "笔记/日记.md"), "笔记/别的.md", ports(), true)?.icon, "cloud-check");
      assert.equal(noteSyncIndicator(view("idle"), "笔记/日记.md", ports(true), true)?.icon, "cloud-pending");
      assert.equal(noteSyncIndicator(view("offline"), "笔记/日记.md", ports(), true)?.icon, "cloud-off");
      assert.equal(noteSyncIndicator(view("idle"), "笔记/日记.md", { tracks: () => false, pending: () => false }, true), null, "notes outside the synced folders show nothing");
    }
    assert.ok(cloud.calls.filter(c => c === "putSmall").length >= 1, "an edited note goes up on its own, immediately");
    assert.ok(cloud.calls.includes("putBatch"), "the startup backlog of small files goes up in batches");
    assert.equal(cloud.calls.includes("uploadUrls"), false, "small files never take the presigned path");
    // B's own mirror goes the other way; A never uploads B's folder.
    b.write(`${SYNC_DEVICES_DIR}/phone-b/company.json`, "{\"b\":2}"); b.engine.noteVaultChange(`${SYNC_DEVICES_DIR}/phone-b/company.json`, "create");
    await b.engine.flush(); await settle(cloud); await a.engine.flush();
    assert.equal(a.read(`${SYNC_DEVICES_DIR}/phone-b/company.json`), "{\"b\":2}");
    const before = cloud.calls.length;
    a.engine.noteVaultChange(`${SYNC_DEVICES_DIR}/phone-b/company.json`, "modify"); await a.engine.flush();
    assert.ok(!cloud.calls.slice(before).includes("putSmall"), "another device's mirror is never uploaded from here");
    // Idempotent: re-flushing unchanged files uploads nothing.
    const quiet = cloud.calls.length; a.engine.noteVaultChange("笔记/日记.md", "modify"); await a.engine.flush();
    assert.ok(!cloud.calls.slice(quiet).includes("putSmall"), "unchanged content is not re-uploaded");
    a.engine.stop(); b.engine.stop();
    ok("two devices: mirrors and notes travel both ways, live push, single writer, nothing re-uploaded, active note and indicators reported");
  }

  {
    const cloud = new FakeCloud();
    const a = device(cloud, "mac-a", "Mac"), b = device(cloud, "phone-b", "iPhone");
    a.write("笔记/x.md", "1"); await a.engine.start(); await settle(cloud); await b.engine.start(); await settle(cloud); await b.engine.flush();
    assert.equal(b.read("笔记/x.md"), "1");
    const cursorBefore = (b.state.value as { cursor: number }).cursor;
    // B goes offline; A keeps writing.
    cloud.live.delete("phone-b"); cloud.offline = true;
    b.write("笔记/mine.md", "离线写的"); b.engine.noteVaultChange("笔记/mine.md", "create"); await b.engine.flush();
    assert.equal(b.engine.snapshot().phase, "offline");
    cloud.offline = false;
    a.write("笔记/x.md", "2"); a.engine.noteVaultChange("笔记/x.md", "modify"); a.write("笔记/y.md", "新"); a.engine.noteVaultChange("笔记/y.md", "create"); await a.engine.flush(); await settle(cloud);
    assert.equal(b.read("笔记/x.md"), "1", "offline device has not seen it yet");
    b.engine.wake(); await b.engine.flush(); await settle(cloud); await a.engine.flush();
    assert.equal(b.read("笔记/x.md"), "2"); assert.equal(b.read("笔记/y.md"), "新");
    assert.equal(a.read("笔记/mine.md"), "离线写的", "the offline edit is uploaded on reconnect");
    assert.ok((b.state.value as { cursor: number }).cursor > cursorBefore, "B resumed from its cursor");
    assert.ok(cloud.calls.filter(c => c === "changes").length < 40, "no full re-download");
    a.engine.stop(); b.engine.stop();
    ok("offline device resumes from its cursor on reconnect, pushing what it wrote meanwhile");
  }

  {
    const cloud = new FakeCloud(); cloud.quota = 1000;
    const a = device(cloud, "mac-a", "Mac");
    a.write("笔记/small.md", "短"); await a.engine.start(); await settle(cloud);
    assert.equal(a.engine.snapshot().phase, "idle"); assert.equal(a.engine.snapshot().nearQuota, false);
    a.write("笔记/medium.md", "中".repeat(140)); a.engine.noteVaultChange("笔记/medium.md", "create"); await a.engine.flush();
    assert.equal(a.engine.snapshot().phase, "idle"); assert.equal(a.engine.snapshot().nearQuota, true, "≥ 90% is a soft warning while uploads still succeed");
    a.write("笔记/big.md", "长".repeat(400)); a.engine.noteVaultChange("笔记/big.md", "create"); await a.engine.flush();
    assert.equal(a.engine.snapshot().phase, "error"); assert.match(cloudFailureText(a.engine.snapshot().lastError), /空间已满/u);
    assert.equal([...cloud.files.values()].length, 3, "nothing partial reached the manifest (keycheck + small + medium)");
    a.engine.stop();
    ok("quota: a refused upload is reported, nothing half-committed");
  }

  {
    const cloud = new FakeCloud();
    const a = device(cloud, "mac-a", "Mac"), b = device(cloud, "phone-b", "iPhone", wrongKey);
    a.write("笔记/secret.md", "机密"); await a.engine.start(); await settle(cloud);
    await b.engine.start();
    assert.equal(b.engine.snapshot().phase, "error"); assert.match(cloudFailureText(b.engine.snapshot().lastError), /密码/u);
    assert.equal(b.read("笔记/secret.md"), undefined, "wrong password: nothing written, nothing damaged");
    assert.ok(!cloud.calls.includes("putSmall") || cloud.calls.filter(c => c === "putSmall").length === 2, "the wrong-password device uploaded nothing");
    const files = [...cloud.files.values()].length;
    assert.equal(files, 2, "A's data in the cloud is untouched");
    a.engine.stop(); b.engine.stop();
    ok("a device with the wrong password neither reads nor damages anything");
  }

  {
    const cloud = new FakeCloud();
    const a = device(cloud, "mac-a", "Mac"), b = device(cloud, "phone-b", "iPhone");
    const note = "# 计划\n\n第一段原文\n\n第二段原文\n\n第三段原文";
    a.write("笔记/计划.md", note); await a.engine.start(); await settle(cloud); await b.engine.start(); await settle(cloud); await b.engine.flush();
    assert.equal(b.read("笔记/计划.md"), note);
    // Both edit different paragraphs while apart.
    cloud.live.clear();
    a.write("笔记/计划.md", "# 计划\n\n第一段 Mac 改\n\n第二段原文\n\n第三段原文"); a.engine.noteVaultChange("笔记/计划.md", "modify"); await a.engine.flush(); await settle(cloud);
    b.write("笔记/计划.md", "# 计划\n\n第一段原文\n\n第二段原文\n\n第三段 iPhone 改"); b.engine.noteVaultChange("笔记/计划.md", "modify"); await b.engine.flush(); await settle(cloud);
    await a.engine.flush(); await settle(cloud); await b.engine.flush(); await settle(cloud); await a.engine.flush();
    const merged = "# 计划\n\n第一段 Mac 改\n\n第二段原文\n\n第三段 iPhone 改";
    assert.equal(a.read("笔记/计划.md"), merged, "A has both edits"); assert.equal(b.read("笔记/计划.md"), merged, "B has both edits");
    assert.equal([...a.fs.files.keys()].filter(p => p.includes("冲突")).length + [...b.fs.files.keys()].filter(p => p.includes("冲突")).length, 0, "no conflict copies");
    // Same paragraph on both sides → one keeps its own, the other side's version is parked beside it.
    a.write("笔记/计划.md", merged.replace("第二段原文", "第二段 Mac")); a.engine.noteVaultChange("笔记/计划.md", "modify"); await a.engine.flush(); await settle(cloud);
    b.write("笔记/计划.md", merged.replace("第二段原文", "第二段 iPhone")); b.engine.noteVaultChange("笔记/计划.md", "modify"); await b.engine.flush(); await settle(cloud);
    await a.engine.flush(); await settle(cloud); await b.engine.flush(); await settle(cloud); await a.engine.flush();
    const conflictsA = [...a.fs.files.keys()].filter(p => p.includes("(冲突")), conflictsB = [...b.fs.files.keys()].filter(p => p.includes("(冲突"));
    assert.ok(conflictsA.length + conflictsB.length >= 1, "an overlapping edit produced a conflict copy");
    assert.ok(a.read("笔记/计划.md")!.includes("第二段 Mac"), "A keeps its own version");
    assert.ok(conflictsA.some(p => a.read(p)!.includes("第二段 iPhone")) || conflictsB.some(p => b.read(p)!.includes("第二段 Mac")), "the other version is kept beside it");
    assert.ok(a.engine.snapshot().conflicts + b.engine.snapshot().conflicts >= 1);
    a.engine.stop(); b.engine.stop();
    ok("notes: different paragraphs merge automatically; the same paragraph makes a conflict copy, nothing is lost");
  }

  {
    const cloud = new FakeCloud(); cloud.smallLimit = 400;
    const a = device(cloud, "mac-a", "Mac"), b = device(cloud, "phone-b", "iPhone");
    a.write("笔记/长文.md", "字".repeat(2_000)); a.write("笔记/图.png", "PNG...");
    await a.engine.start(); await settle(cloud); await b.engine.start(); await settle(cloud); await b.engine.flush();
    assert.ok(cloud.calls.includes("uploadUrls") && cloud.calls.includes("commit"), "large files take the presigned path");
    assert.equal(b.read("笔记/长文.md"), "字".repeat(2_000));
    assert.equal(b.read("笔记/图.png"), undefined, "attachments stay local unless chosen");
    // Delete propagates when the other side has not edited it.
    a.fs.files.delete("笔记/长文.md"); a.engine.noteVaultChange("笔记/长文.md", "delete"); await a.engine.flush(); await settle(cloud); await b.engine.flush();
    assert.equal(b.read("笔记/长文.md"), undefined, "a deletion travels");
    // Password reset elsewhere: the next pass sees the key epoch change and re-uploads from local files.
    await cloud.client("mac-a").reset(); await settle(cloud);
    a.write("笔记/新.md", "重传"); a.engine.noteVaultChange("笔记/新.md", "create"); await a.engine.flush(); await settle(cloud);
    assert.equal((a.state.value as { keyEpoch: number }).keyEpoch, 1);
    assert.ok([...cloud.files.values()].some(f => !f.deleted), "the device re-uploaded after the reset");
    a.engine.stop(); b.engine.stop();
    ok("large files, attachment opt-out, deletions and key-epoch reset");
  }

  {
    const cloud = new FakeCloud();
    const fs = new DeviceVault(); fs.files.set("笔记/a.md", "a");
    const local = new Map<string, unknown>(); const settings = { enabled: false, excludedFolders: [], includeAttachments: false, deviceName: "" };
    let session: { apiUrl: string; token: string; accountId: string; passwordSet: boolean; deviceId: string | null } | null = { apiUrl: "http://x", token: "t", accountId: "u-1", passwordSet: true, deviceId: "pro-mac-a" };
    let saved = 0;
    const make = () => new CloudSyncController({ fs, transport: { json: async () => ({ status: 500, body: null, headers: {} }), putBytes: async () => 500, getBytes: async () => ({ status: 500, bytes: new Uint8Array() }) },
      deviceId: "mac-a", deviceKind: "desktop", defaultDeviceName: "Mac", session: () => session, settings: () => settings, saveSettings: async () => { saved++; },
      local: { load: key => local.get(key) ?? null, save: (key, value) => { local.set(key, value); } }, base: memoryBase(), timers, clientFactory: () => cloud.client("mac-a") });
    const controller = make();
    await controller.start();
    assert.equal(controller.view().status, null, "off → nothing runs");
    session = { ...session!, passwordSet: false };
    await assert.rejects(controller.enable("x"), /PASSWORD_REQUIRED/u);
    session = { ...session, passwordSet: true, deviceId: null };
    await assert.rejects(controller.enable("x"), /DEVICE_REQUIRED/u, "the PRO device must be enabled first");
    session = { ...session, deviceId: "pro-mac-a" };
    await controller.enable("方哥的密码");
    assert.equal(controller.view().enabled, true); assert.equal(controller.view().keyReady, true); assert.equal(settings.enabled, true); assert.ok(saved >= 1);
    assert.equal(controller.deviceId, "pro-mac-a", "the cloud identity is the PRO device id");
    assert.ok([...cloud.files.values()].every(f => f.deviceId === "mac-a"), "the fake client was bound by the test; the mirror folder id stays 甲's");
    assert.ok([...local.keys()].some(k => k.startsWith("echoink-cloud-sync-key-v1:")), "the derived key is cached on the device");
    await cloud.settle();
    assert.ok([...cloud.files.values()].length >= 2, "the engine ran");
    controller.dispose();
    // Next launch: enabled + cached key → starts without asking for the password.
    const next = make(); await next.start();
    assert.equal(next.view().status?.phase, "idle");
    // Wrong password on another device is refused and does not flip the switch.
    const other = new CloudSyncController({ fs: new DeviceVault(), transport: { json: async () => ({ status: 500, body: null, headers: {} }), putBytes: async () => 500, getBytes: async () => ({ status: 500, bytes: new Uint8Array() }) },
      deviceId: "phone-b", deviceKind: "phone", defaultDeviceName: "iPhone", session: () => session, settings: () => ({ enabled: false, excludedFolders: [], includeAttachments: false, deviceName: "" }), saveSettings: async () => {},
      local: { load: () => null, save: () => {} }, base: memoryBase(), timers, clientFactory: () => cloud.client("phone-b") });
    await assert.rejects(other.enable("错的密码"), /DECRYPT|密码/u);
    assert.equal(other.view().enabled, false);
    await next.disable(); assert.equal(next.view().status, null); assert.equal(settings.enabled, false);
    next.dispose(); other.dispose();
    assert.deepEqual(normalizeCloudSyncSettings(undefined).excludedFolders, []);
    ok("controller: on with the password (cached after), off, wrong password refused, default folders");
  }
}
