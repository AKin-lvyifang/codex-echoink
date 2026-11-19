import assert from "node:assert/strict";
import { cloudPathInScope, cloudFolderState, cloudFolderChildren, toggleCloudFolder } from "../sync/cloud/scope";
import { CloudSyncController } from "../sync/cloud/controller";
import { CloudApiError, CloudNetworkError, type CloudSyncClientPort } from "../sync/cloud/client";
import { CloudSyncEngine, type CloudSyncEngineOptions, type CloudSyncScope } from "../sync/cloud/engine";
import { deriveMasterKey, decryptEntry, pathToken, sha256Hex } from "../sync/cloud/crypto";
import { normalizeCloudSyncSettings } from "../sync/cloud/settings";
import { DeviceVault, FakeCloud, memoryBase, memoryState, timers } from "./sync-cloud";
import { CloudSyncHistory, HISTORY_PER_FILE, type CloudHistoryFs } from "../sync/cloud/history";

/** Compatibility fields let these regressions run against the pre-change engine as well. */
const scope = (excludedFolders: string[] = [], includeAttachments = true) => ({ excludedFolders, includeAttachments, folders: excludedFolders.includes("notes") ? [] : ["notes", "EchoInk", "root.md"] });

function syncTestClock() {
  let now = 0, nextId = 0;
  const scheduled = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => now,
    timers: {
      ...timers,
      setTimeout(run: () => void, delay: number) {
        const id = ++nextId;
        scheduled.set(id, { at: now + delay, run });
        return id;
      },
      clearTimeout(id: number) { scheduled.delete(id); }
    },
    async advance(ms: number) {
      now += ms;
      for (const [id, task] of scheduled) {
        if (task.at <= now) { scheduled.delete(id); task.run(); }
      }
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  };
}

async function waitForSync(getPhase: () => string | undefined) {
  const deadline = Date.now() + 2_000;
  while (getPhase() !== "idle" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(getPhase(), "idle", "sync must recover without another wake or flush");
}

export async function runWholeVaultTests(): Promise<void> {
  const key = await deriveMasterKey("synthetic-sync-fixture", "whole-vault", 1_000);
  const active: CloudSyncEngine[] = [], failures: string[] = [];
  let passed = 0;
  const device = (cloud: FakeCloud, id: string, selected = scope(), client = cloud.client(id), fs = new DeviceVault(), state = memoryState(), base = memoryBase(), overrides: Partial<CloudSyncEngineOptions> = {}) => {
    const options = { fs, client, key, deviceId: id, deviceName: id, deviceKind: "desktop" as const, scope: () => selected as CloudSyncScope,
      state, base, timers, debounceMs: 400, ignoredRoots: ["config"], caseInsensitivePaths: true, ...overrides };
    const engine = new CloudSyncEngine(options); active.push(engine);
    return { engine, fs, state, base, scope: selected, client };
  };
  type Device = ReturnType<typeof device>;
  const changeScope = (d: Device, excluded: string[], attachments = d.scope.includeAttachments) => {
    Object.assign(d.scope, scope(excluded, attachments));
    const updated = d.engine as CloudSyncEngine & { scopeChanged?: () => void };
    if (updated.scopeChanged) updated.scopeChanged(); else updated.wake();
  };
  const test = async (name: string, run: () => Promise<void>) => {
    try { await run(); passed++; console.log(`PASS whole-vault: ${name}`); }
    catch (error) { failures.push(name); console.error(`FAIL whole-vault: ${name}: ${error instanceof Error ? error.message : String(error)}`); }
    finally { for (const e of active.splice(0)) e.stop(); }
  };
  const pair = async (file = "notes/x.md", body = "base") => {
    const cloud = new FakeCloud(), a = device(cloud, "a"), b = device(cloud, "b");
    a.fs.files.set(file, body); await a.engine.start(); await cloud.settle(); await b.engine.start(); await cloud.settle(); await b.engine.flush(); cloud.live.clear();
    return { cloud, a, b };
  };
  const copies = (d: Device) => [...d.fs.files.keys()].filter(p => p.includes("(冲突 "));

  await test("settings: whole vault and attachments default on, explicit false survives", async () => {
    assert.deepEqual(normalizeCloudSyncSettings({ folders: ["old"] }), { enabled: false, excludedFolders: [], includeAttachments: true, deviceName: "" });
    const value = normalizeCloudSyncSettings({ excludedFolders: ["notes", "notes", "a/b", ".obsidian", ".."], includeAttachments: false });
    assert.deepEqual(normalizeCloudSyncSettings({ excludedFolders: [" My Notes "] }).excludedFolders, [" My Notes "], "folder names retain their exact spaces");
    assert.equal(value.includeAttachments, false); assert.deepEqual((value as unknown as { excludedFolders: string[] }).excludedFolders, ["notes", "a/b"]);
    assert.deepEqual(normalizeCloudSyncSettings({ excludedFolders: ["a/b/c", "a/b", "a//x", "a/.hidden", "/a", "a/", "x\\y", "abc"] }).excludedFolders, ["a/b", "abc"], "nested paths are kept; malformed ones and entries already covered by an ancestor are dropped");
  });
  await test("scope: nested folder exclusion covers the subtree only", async () => {
    const nested = { excludedFolders: ["notes/private", "archive"], includeAttachments: true };
    assert.equal(cloudPathInScope("notes/a.md", nested, "EchoInk/同步数据/设备/a"), true);
    assert.equal(cloudPathInScope("notes/private", nested, "EchoInk/同步数据/设备/a"), false);
    assert.equal(cloudPathInScope("notes/private/deep/b.md", nested, "EchoInk/同步数据/设备/a"), false);
    assert.equal(cloudPathInScope("notes/private-ish/c.md", nested, "EchoInk/同步数据/设备/a"), true, "a sibling sharing the prefix is not excluded");
    assert.equal(cloudPathInScope("archive/2025/d.md", nested, "EchoInk/同步数据/设备/a"), false);
    assert.equal(cloudFolderState("notes", nested.excludedFolders), "mixed"); assert.equal(cloudFolderState("notes/private/deep", nested.excludedFolders), "false"); assert.equal(cloudFolderState("Inbox", nested.excludedFolders), "true");
    const tree: Record<string, string[]> = { "": ["Wiki", "Inbox"], Wiki: ["Wiki/概念", "Wiki/项目"], "Wiki/项目": ["Wiki/项目/EchoInk", "Wiki/项目/官网"] };
    const kids = async (folder: string) => tree[folder] ?? [];
    assert.deepEqual(await toggleCloudFolder("Wiki", [], kids), ["Wiki"]);
    assert.deepEqual((await toggleCloudFolder("Wiki/项目/EchoInk", ["Wiki"], kids)).sort(), ["Wiki/概念", "Wiki/项目/官网"].sort(), "re-including one branch keeps its siblings excluded");
    assert.deepEqual(await toggleCloudFolder("Wiki", ["Wiki/概念", "Wiki/项目/官网", "Inbox"], kids), ["Inbox"], "a partly synced folder becomes fully synced");
    assert.deepEqual(await toggleCloudFolder("Wiki/项目", ["Wiki/项目/官网"], kids), [], "partial child clears before excluding");
    assert.deepEqual(cloudFolderChildren("Wiki", ["Wiki/概念", "Wiki/项目", "Wiki/.trash", "Other/x"], ["Wiki/已删", "Wiki/概念/x"]), ["Wiki/概念", "Wiki/项目", "Wiki/已删"].sort((a, b) => a.localeCompare(b)));
    assert.deepEqual(cloudFolderChildren("EchoInk", ["EchoInk/同步数据", "EchoInk/笔记"], []), ["EchoInk/笔记"], "the sync mailbox is never offered");
  });
  await test("engine: a nested excluded folder is neither uploaded nor received, its parent still syncs", async () => {
    const cloud = new FakeCloud(), a = device(cloud, "a", scope(["notes/private"]));
    a.fs.files.set("notes/keep.md", "keep"); a.fs.files.set("notes/private/secret.md", "secret"); a.fs.files.set("notes/private/deep/more.md", "more");
    await a.engine.start();
    const b = device(cloud, "b"); await b.engine.start();
    assert.equal(b.fs.files.get("notes/keep.md"), "keep"); assert.equal(b.fs.files.has("notes/private/secret.md"), false); assert.equal(b.fs.files.has("notes/private/deep/more.md"), false);
  });
  await test("scope: root files and newly named folders, internal paths never upload", async () => {
    const cloud = new FakeCloud(), a = device(cloud, "a");
    for (const p of ["root.md", "Inbox/a.md", "Journal/a.md"]) a.fs.files.set(p, p);
    for (const p of [".obsidian/plugins/x/cloud-sync-base/x.txt", "config/plugins/x/data.json", "notes/.cache/a.json", "EchoInk/待办-settings-backup.json"]) a.fs.files.set(p, "private");
    await a.engine.start(); await cloud.settle();
    assert.equal(cloud.files.size, 4, "keycheck plus the three visible files only");
    const b = device(cloud, "b"); cloud.live.clear(); await b.engine.start();
    assert.equal(b.fs.files.get("Inbox/a.md"), "Inbox/a.md"); assert.equal(b.fs.files.get("root.md"), "root.md");
  });
  await test("root writes create no truncated-name directory", async () => {
    const cloud = new FakeCloud(), a = device(cloud, "a"); await a.engine.start();
    a.fs.files.set("root.md", "root"); a.engine.noteVaultChange("root.md", "create"); await a.engine.flush(); await cloud.settle(); cloud.live.clear();
    const b = device(cloud, "b"); await b.engine.start(); assert.equal(b.fs.files.get("root.md"), "root"); assert.deepEqual([...b.fs.folders], []);
  });
  await test("initial same-path text preserves both versions", async () => {
    const cloud = new FakeCloud(), a = device(cloud, "a"), b = device(cloud, "b"); a.fs.files.set("notes/x.md", "remote"); await a.engine.start(); await cloud.settle(); cloud.live.clear();
    b.fs.files.set("notes/x.md", "local"); await b.engine.start(); assert.equal(b.fs.files.get("notes/x.md"), "local"); assert.ok(copies(b).some(p => b.fs.files.get(p) === "remote"));
  });
  await test("a local blank tail never diverts three successive remote saves into conflict copies", async () => {
    const path = "README-测试仓库.md", original = "我赠送了你一支笔\n";
    const { cloud, a, b } = await pair(path, original);
    b.fs.files.set(path, original + " \n");
    b.engine.noteVaultChange(path, "modify");
    for (const sentence of ["这支笔", "这支笔请你收下", "这支笔请你收下，好好写字。"]) {
      const latest = original + sentence + "\n";
      a.fs.files.set(path, latest);
      a.engine.noteVaultChange(path, "modify");
      await a.engine.flush();
      await cloud.settle();
      await b.engine.flush();
      assert.equal(b.fs.files.get(path), latest);
      assert.deepEqual(copies(b), []);
    }
    assert.equal(a.fs.files.get(path), b.fs.files.get(path));
    assert.deepEqual(copies(a), []);
    assert.equal(a.engine.snapshot().pending + b.engine.snapshot().pending, 0);
  });
  await test("a remote blank tail yields to the full local edit and both devices converge", async () => {
    const path = "notes/x.md", original = "末行\n";
    const { cloud, a, b } = await pair(path, original);
    const latest = original + "保留行尾原文。  \n\t\n";
    b.fs.files.set(path, latest); b.engine.noteVaultChange(path, "modify");
    a.fs.files.set(path, original + "\t\n"); a.engine.noteVaultChange(path, "modify");
    await a.engine.flush(); await cloud.settle(); await b.engine.flush();
    await cloud.settle(); await a.engine.flush();
    assert.equal(a.fs.files.get(path), latest);
    assert.equal(b.fs.files.get(path), latest);
    assert.deepEqual([...copies(a), ...copies(b)], []);
    assert.equal(a.engine.snapshot().pending + b.engine.snapshot().pending, 0);
  });
  await test("files without a common version choose the same original in both arrival orders", async () => {
    const path = "notes/x.txt", body = "相同正文  ";
    for (const [winner, other] of [[body, body + "\r\n\t"], [body + "\n\t\n", body + "\n \n"]]) {
      for (const [first, second] of [[winner, other], [other, winner]]) {
        const cloud = new FakeCloud(), a = device(cloud, "a"), b = device(cloud, "b");
        a.fs.files.set(path, first); b.fs.files.set(path, second);
        await a.engine.start(); await cloud.settle(); cloud.live.clear();
        assert.equal(await b.base.read(path), null);
        await b.engine.start(); await cloud.settle(); await a.engine.flush(); await b.engine.flush();
        assert.equal(a.fs.files.get(path), winner);
        assert.equal(b.fs.files.get(path), winner);
        assert.deepEqual([...copies(a), ...copies(b)], []);
        assert.equal(a.engine.snapshot().pending + b.engine.snapshot().pending, 0);
        a.engine.stop(); b.engine.stop();
      }
    }
  });
  await test("when both devices change only the tail, a closed code block still permits a stable tie-break", async () => {
    const path = "notes/x.md", original = "~~~txt\ncode\n~~~\n末行\n";
    const { cloud, a, b } = await pair(path, original);
    const winner = original + "\t\n";
    a.fs.files.set(path, original + " \n"); a.engine.noteVaultChange(path, "modify");
    b.fs.files.set(path, winner); b.engine.noteVaultChange(path, "modify");
    await a.engine.flush(); await cloud.settle(); await b.engine.flush();
    await cloud.settle(); await a.engine.flush();
    assert.equal(a.fs.files.get(path), winner);
    assert.equal(b.fs.files.get(path), winner);
    assert.deepEqual([...copies(a), ...copies(b)], []);
    assert.equal(a.engine.snapshot().pending + b.engine.snapshot().pending, 0);
  });
  await test("Markdown hard breaks, internal blank lines and open fences still preserve both changes", async () => {
    const path = "notes/x.md";
    for (const [original, mine, theirs] of [
      ["前文\n末行\n", "前文\n末行  \n", "前文\n改写末行\n"],
      ["第一行\n最后一行\n", "第一行\n\n最后一行\n", "第一行\n插入正文\n最后一行\n"],
      ["````text\ncode\n> ````\n```\n", "````text\ncode\n> ````\n```\n \n", "````text\ncode\n> ````\n```\nmore code\n"],
      ["- ~~~text\n  code\n", "- ~~~text\n  code\n \n", "- ~~~text\n  code\n  more code\n"],
      ["- item\n  ~~~\n  code\n~~~\ncode\n", "- item\n  ~~~\n  code\n~~~\ncode\n \n", "- item\n  ~~~\n  code\n~~~\ncode\nmore code\n"]
    ]) {
      const { cloud, a, b } = await pair(path, original);
      a.fs.files.set(path, theirs); a.engine.noteVaultChange(path, "modify");
      b.fs.files.set(path, mine); b.engine.noteVaultChange(path, "modify");
      await a.engine.flush(); await cloud.settle(); await b.engine.flush();
      assert.equal(b.fs.files.get(path), mine);
      assert.deepEqual(copies(b).map(copy => b.fs.files.get(copy)), [theirs]);
      a.engine.stop(); b.engine.stop();
    }
  });
  await test("A: expanding scope scans existing local files immediately", async () => {
    const cloud = new FakeCloud(), a = device(cloud, "a", scope(["notes"])); a.fs.files.set("notes/x.md", "local"); await a.engine.start(); changeScope(a, []); await a.engine.flush();
    assert.equal(cloud.files.size, 2);
  });
  await test("B: previously observed out-of-scope remote is downloaded on recheck", async () => {
    const cloud = new FakeCloud(), a = device(cloud, "a"), b = device(cloud, "b", scope(["notes"])); a.fs.files.set("notes/x.md", "remote"); await a.engine.start(); await cloud.settle(); cloud.live.clear();
    await b.engine.start(); assert.equal(b.fs.files.get("notes/x.md"), undefined); changeScope(b, []); await b.engine.flush(); assert.equal(b.fs.files.get("notes/x.md"), "remote");
    const downloads = cloud.calls.filter(x => x === "downloadUrls").length; changeScope(b, []); await b.engine.flush(); assert.equal(cloud.calls.filter(x => x === "downloadUrls").length, downloads, "no repeated body download");
  });
  await test("legacy B record is compensated without resetting normal cursor", async () => {
    const cloud = new FakeCloud(), a = device(cloud, "a"); a.fs.files.set("notes/x.md", "remote"); await a.engine.start(); await cloud.settle(); cloud.live.clear();
    const token = await pathToken(key, "notes/x.md"), state = memoryState(); state.value = { cursor: cloud.cursor, keyEpoch: 0, entries: { "notes/x.md": { token, rev: 0, sha256: "", remote: { deviceId: "a", rev: 1 } } } };
    const b = device(cloud, "b", scope(), undefined, undefined, state); await b.engine.start(); assert.equal(b.fs.files.get("notes/x.md"), "remote"); assert.ok(b.engine.snapshot().cursor >= cloud.cursor);
  });
  await test("legacy compensation resumes after network failure and restart", async () => {
    const cloud = new FakeCloud(), a = device(cloud, "a"); a.fs.files.set("notes/x.md", "remote"); await a.engine.start(); cloud.live.clear();
    const token = await pathToken(key, "notes/x.md"), state = memoryState(); state.value = { cursor: cloud.cursor, keyEpoch: 0, entries: { "notes/x.md": { token, rev: 0, sha256: "", remote: { deviceId: "a", rev: 1 } } } };
    const client = cloud.client("b"), changes = client.changes; let fromZero = 0;
    client.changes = async since => { if (since === 0 && ++fromZero === 2) throw new CloudNetworkError(); return changes(since); };
    const b = device(cloud, "b", scope(), client, undefined, state); await b.engine.start(); assert.equal(b.engine.snapshot().phase, "offline"); b.engine.stop();
    const resumed = device(cloud, "b", scope(), undefined, b.fs, b.state, b.base); await resumed.engine.start(); assert.equal(resumed.fs.files.get("notes/x.md"), "remote");
  });
  await test("scope shrink drops queued upload and ignores remote deletion", async () => {
    const { cloud, a, b } = await pair(); b.fs.files.set("notes/pending.md", "pending"); b.engine.noteVaultChange("notes/pending.md", "create"); changeScope(b, ["notes"]); await b.engine.flush();
    const pendingToken = await pathToken(key, "notes/pending.md"); assert.ok(![...cloud.files.values()].some(x => x.deviceId === "b" && x.path === pendingToken));
    a.fs.files.delete("notes/x.md"); a.engine.noteVaultChange("notes/x.md", "delete"); await a.engine.flush(); await b.engine.flush(); assert.equal(b.fs.files.get("notes/x.md"), "base");
  });
  await test("rechecking reconciles changes made on both sides while excluded", async () => {
    const { cloud, a, b } = await pair(); changeScope(b, ["notes"]); await b.engine.flush(); b.fs.files.set("notes/local.md", "local");
    a.fs.files.set("notes/remote.md", "remote"); a.engine.noteVaultChange("notes/remote.md", "create"); await a.engine.flush(); await cloud.settle(); await b.engine.flush();
    changeScope(b, []); await b.engine.flush(); await cloud.settle(); await a.engine.flush(); assert.equal(b.fs.files.get("notes/remote.md"), "remote"); assert.equal(a.fs.files.get("notes/local.md"), "local");
  });
  await test("unmodified binary deletion propagates; edited binary survives", async () => {
    const { cloud, a, b } = await pair("notes/image.png", "original");
    a.fs.files.delete("notes/image.png"); a.engine.noteVaultChange("notes/image.png", "delete"); await a.engine.flush(); await b.engine.flush(); assert.equal(b.fs.files.get("notes/image.png"), undefined);
    const c = device(cloud, "c"); c.fs.files.set("notes/image.png", "edited"); await c.engine.start(); await cloud.settle(); assert.equal(c.fs.files.get("notes/image.png"), "edited");
  });
  await test("attachment off/on handles all non-text types and preserves bytes", async () => {
    const cloud = new FakeCloud(), a = device(cloud, "a"), b = device(cloud, "b", scope([], false)); const bytes = new Uint8Array([0, 255, 254, 128, 13, 10, 1]);
    await a.fs.writeBinary("notes/file.docx", bytes.buffer); await a.engine.start(); await cloud.settle(); cloud.live.clear(); await b.engine.start(); assert.equal(b.fs.files.get("notes/file.docx"), undefined);
    changeScope(b, [], true); await b.engine.flush(); assert.deepEqual(new Uint8Array(await b.fs.readBinary("notes/file.docx")), bytes);
  });
  await test("structured files preserve both edits instead of line merging", async () => {
    const { cloud, a, b } = await pair("notes/x.canvas", '{\n"a":1,\n"b":1\n}');
    a.fs.files.set("notes/x.canvas", '{\n"a":2,\n"b":1\n}'); a.engine.noteVaultChange("notes/x.canvas", "modify"); await a.engine.flush(); await cloud.settle();
    b.fs.files.set("notes/x.canvas", '{\n"a":1,\n"b":2\n}'); b.engine.noteVaultChange("notes/x.canvas", "modify"); await b.engine.flush(); assert.equal(b.fs.files.get("notes/x.canvas"), '{\n"a":1,\n"b":2\n}'); assert.ok(copies(b).length);
  });
  await test("case-only path collision preserves local and remote contents", async () => {
    const cloud = new FakeCloud(), a = device(cloud, "a"), b = device(cloud, "b"); a.fs.files.set("Journal/x.md", "remote"); await a.engine.start(); await cloud.settle(); cloud.live.clear();
    b.fs.files.set("journal/x.md", "local"); await b.engine.start(); assert.equal(b.fs.files.get("journal/x.md"), "local"); assert.equal(b.fs.files.get("Journal/x.md"), undefined); assert.ok(copies(b).some(p => b.fs.files.get(p) === "remote"));
  });
  await test("new local folders retain case protection after engine startup", async () => {
    const cloud = new FakeCloud(), a = device(cloud, "a"), b = device(cloud, "b"); await a.engine.start(); await b.engine.start(); cloud.live.clear();
    b.fs.files.set("journal/x.md", "local"); b.engine.noteVaultChange("journal/x.md", "create"); await b.engine.flush();
    a.fs.files.set("Journal/x.md", "remote"); a.engine.noteVaultChange("Journal/x.md", "create"); await a.engine.flush(); await b.engine.flush();
    assert.equal(b.fs.files.get("journal/x.md"), "local"); assert.equal(b.fs.files.get("Journal/x.md"), undefined); assert.ok(copies(b).some(p => b.fs.files.get(p) === "remote"));
  });
  await test("edited binary survives a concurrent deletion and reaches the deleting device", async () => {
    const { cloud, a, b } = await pair("notes/image.png", "original"), edited = new Uint8Array([255,0,128,1]);
    await b.fs.writeBinary("notes/image.png", edited.buffer); b.engine.noteVaultChange("notes/image.png", "modify");
    a.fs.files.delete("notes/image.png"); a.engine.noteVaultChange("notes/image.png", "delete"); await a.engine.flush(); await b.engine.flush(); await cloud.settle(); await a.engine.flush();
    assert.deepEqual(new Uint8Array(await a.fs.readBinary("notes/image.png")), edited); assert.deepEqual(new Uint8Array(await b.fs.readBinary("notes/image.png")), edited);
  });
  await test("repeated conflicts never overwrite an earlier copy", async () => {
    const { cloud, a, b } = await pair(); b.fs.files.set("notes/x.md", "mine");
    for (const value of ["first", "second"]) { a.fs.files.set("notes/x.md", value); a.engine.noteVaultChange("notes/x.md", "modify"); await a.engine.flush(); await cloud.settle(); await b.engine.flush(); }
    assert.equal(copies(b).length, 2); assert.deepEqual(copies(b).map(p => b.fs.files.get(p)).sort(), ["first", "second"]);
  });
  await test("mid-batch failure survives wake and process restart", async () => {
    const cloud = new FakeCloud(), client = cloud.client("a"); let remaining = 2, armed = false; const put = client.putSmall;
    client.putSmall = async file => { if (armed && --remaining === 0) throw new CloudNetworkError(); return put(file); };
    const a = device(cloud, "a", scope(), client); await a.engine.start(); armed = true;
    for (const n of ["a", "b", "c"]) { a.fs.files.set(`notes/${n}.md`, n); a.engine.noteVaultChange(`notes/${n}.md`, "create"); }
    await a.engine.flush(); assert.ok(a.engine.snapshot().pending > 0); a.engine.stop();
    const restarted = device(cloud, "a", scope(), undefined, a.fs, a.state, a.base); await restarted.engine.start(); assert.equal(cloud.files.size, 4); assert.equal(restarted.engine.snapshot().pending, 0);
  });
  await test("startup HTTP 429 blocks device usage and wakes until one automatic retry", async () => {
    const cloud = new FakeCloud(), client = cloud.client("a"), clock = syncTestClock(), fs = new DeviceVault();
    const logged: unknown[][] = [];
    const register = client.register; let registrations = 0;
    client.register = async input => {
      if (++registrations === 1) throw new CloudApiError("REQUEST_FAILED", 429, { retryAfter: 230 });
      return register(input);
    };
    const settings = normalizeCloudSyncSettings({ enabled: true });
    const controller = new CloudSyncController({ fs, base: memoryBase(), timers: clock.timers, now: clock.now,
      deviceId: "a", deviceKind: "desktop", defaultDeviceName: "fixture", settings: () => settings, saveSettings: async () => {},
      session: () => ({ apiUrl: "https://fixture.invalid", token: "synthetic", accountId: "fixture", deviceId: "a", passwordSet: true }),
      local: { load: name => name.startsWith("echoink-cloud-sync-key-v1:") ? key.raw : null, save: () => {} },
      clientFactory: () => client, onError: (error, delay) => { if (error instanceof CloudApiError) logged.push([error.status, error.code, delay]); },
      transport: { json: async () => { throw new Error("fixture client required"); }, putBytes: async () => 500, getBytes: async () => ({ status: 500, bytes: new Uint8Array() }) } });
    try {
      await controller.start();
      assert.equal(controller.view().status?.phase, "rate-limited");
      assert.deepEqual(cloud.calls, [], "startup must not follow a 429 with a usage read");
      controller.wake();
      await controller.refreshDevices();
      fs.files.set("notes/startup.md", "written while waiting");
      controller.noteVaultChange("notes/startup.md", "create");
      await clock.advance(229_999);
      assert.equal(registrations, 1);
      assert.deepEqual(cloud.calls, []);
      assert.equal(controller.view().status?.phase, "rate-limited");
      assert.deepEqual(logged, [[429, "REQUEST_FAILED", 230_000]]);
      await clock.advance(1);
      await waitForSync(() => controller.view().status?.phase);
      assert.equal(registrations, 2);
      assert.equal(controller.view().devices[0]?.deviceId, "a");
      assert.equal(cloud.files.size, 2);
      await controller.disable();
      client.register = async () => { throw new CloudApiError("RATE_LIMITED", 429, { retryAfter: 3 }); };
      await assert.rejects(controller.enable("synthetic-enable-password"), { message: "SYNC_ENABLE_RATE_LIMITED" });
      assert.equal(controller.view().enableRateLimited, true);
      assert.equal(controller.view().enabled, false);
      const callsBeforeEnableRetry = [...cloud.calls];
      await controller.refreshDevices();
      assert.deepEqual(cloud.calls, callsBeforeEnableRetry);
      await clock.advance(3_000);
      assert.equal(controller.view().status, null, "failed first enable waits for the user, with no auto-retry");
      assert.deepEqual(logged, [[429, "REQUEST_FAILED", 230_000], [429, "RATE_LIMITED", 3_000]]);
    } finally { controller.dispose(); }
  });
  await test("upload 429 holds wakes, debounce, flush and live reconnect while saving", async () => {
    const cloud = new FakeCloud(), client = cloud.client("a"), clock = syncTestClock(), state = memoryState();
    const save = state.save.bind(state), put = client.putSmall;
    let releasesSave: (() => void) | undefined, savingFailure: Promise<void> | undefined;
    let reportSavingFailure!: () => void;
    const failureSaveStarted = new Promise<void>(resolve => { reportSavingFailure = resolve; });
    state.save = async data => {
      if (savingFailure) { const blocked = savingFailure; savingFailure = undefined; reportSavingFailure(); await blocked; }
      await save(data);
    };
    const a = device(cloud, "a", scope(), client, undefined, state, undefined, { timers: clock.timers, now: clock.now });
    const live = client.live;
    let liveOpens = 0;
    client.live = (id, handlers) => {
      liveOpens++;
      return live(id, { ...handlers, onOpen: (_cursor, epoch) => handlers.onOpen(a.engine.snapshot().cursor, epoch) });
    };
    await a.engine.start();
    const phases: string[] = [];
    a.engine.subscribe(() => phases.push(a.engine.snapshot().phase));
    let uploads = 0;
    client.putSmall = async file => {
      if (++uploads === 1) {
        savingFailure = new Promise<void>(resolve => { releasesSave = resolve; });
        throw new CloudApiError("RATE_LIMITED", 429, { retryAfter: 3 });
      }
      return put(file);
    };
    a.fs.files.set("notes/x.md", "x"); a.engine.noteVaultChange("notes/x.md", "create");
    const failed = a.engine.flush();
    await failureSaveStarted;
    const callsAtFailure = [...cloud.calls];
    a.engine.wake();
    releasesSave!();
    await failed;
    assert.equal(a.engine.snapshot().phase, "rate-limited");
    assert.ok(a.engine.snapshot().pending > 0);
    cloud.live.get("a")?.onClose();
    a.fs.files.set("notes/y.md", "y"); a.engine.noteVaultChange("notes/y.md", "create");
    a.engine.wake();
    await a.engine.flush();
    await clock.advance(2_999);
    assert.deepEqual(cloud.calls, callsAtFailure);
    assert.equal(uploads, 1);
    assert.equal(liveOpens, 1);
    assert.equal(phases.slice(phases.indexOf("rate-limited")).includes("syncing"), false);
    await clock.advance(1);
    await waitForSync(() => a.engine.snapshot().phase);
    await clock.advance(400);
    assert.equal(uploads, 3);
    assert.equal(liveOpens, 2);
    assert.equal(phases.filter((phase, index) => phase === "syncing" && phases[index - 1] !== "syncing").length, 2);
    assert.equal(a.engine.snapshot().pending, 0);
    for (const [path, body] of [["notes/x.md", "x"], ["notes/y.md", "y"]]) {
      const entry = cloud.files.get(`a\0${await pathToken(key, path)}`);
      assert.equal(new TextDecoder().decode((await decryptEntry(key, entry!.bytes!)).body), body);
    }
  });
  await test("file read errors never publish a deletion", async () => {
    const { cloud, a } = await pair(); const read = a.fs.readBinary.bind(a.fs); a.fs.readBinary = async () => { throw new Error("injected I/O failure"); };
    a.engine.noteVaultChange("notes/x.md", "modify"); await a.engine.flush(); assert.ok(![...cloud.files.values()].find(x => x.deviceId === "a" && x.path !== "meta/keycheck")?.deleted);
    a.fs.readBinary = read; a.engine.wake(); await a.engine.flush();
  });
  await test("upload receipts cannot skip a concurrent remote write", async () => {
    const cloud = new FakeCloud(), a = device(cloud, "a"), b = device(cloud, "b"); await a.engine.start(); await b.engine.start(); cloud.live.clear(); a.engine.stop();
    const client = cloud.client("a"), put = client.putSmall; let injected = false;
    client.putSmall = async file => { if (!injected) { injected = true; b.fs.files.set("notes/from-b.md", "B"); b.engine.noteVaultChange("notes/from-b.md", "create"); await b.engine.flush(); await cloud.settle(); } return put(file); };
    const a2 = device(cloud, "a", scope(), client); a2.fs.files.set("notes/from-a.md", "A"); await a2.engine.start(); await cloud.settle(); await a2.engine.flush(); assert.equal(a2.fs.files.get("notes/from-b.md"), "B");
  });
  await test("uploads read and encrypt one file at a time", async () => {
    const cloud = new FakeCloud(), client = cloud.client("a"), a = device(cloud, "a", scope(), client); await a.engine.start();
    let reads = 0, uploads = 0; const read = a.fs.readBinary.bind(a.fs), put = client.putSmall; a.fs.readBinary = async p => { reads++; return read(p); };
    client.putSmall = async file => { uploads++; assert.ok(reads <= uploads, "whole batch was buffered before the first upload"); return put(file); };
    for (const n of ["a", "b", "c"]) { a.fs.files.set(`notes/${n}.md`, n); a.engine.noteVaultChange(`notes/${n}.md`, "create"); }
    await a.engine.flush(); assert.equal(uploads, 3);
  });
  await test("remote uploads refresh measured usage", async () => {
    const { cloud, a, b } = await pair(); a.fs.files.set("notes/new.md", "new data"); a.engine.noteVaultChange("notes/new.md", "create"); await a.engine.flush(); await cloud.settle(); await b.engine.flush(); assert.equal(b.engine.snapshot().usedBytes, cloud.used);
  });
  await test("delete versus edit keeps the edited note and restores it on the deleting side", async () => {
    const { cloud, a, b } = await pair(); b.fs.files.set("notes/x.md", "edited"); b.engine.noteVaultChange("notes/x.md", "modify");
    a.fs.files.delete("notes/x.md"); a.engine.noteVaultChange("notes/x.md", "delete"); await a.engine.flush(); await b.engine.flush(); await cloud.settle(); await a.engine.flush();
    assert.equal(a.fs.files.get("notes/x.md"), "edited"); assert.equal(b.fs.files.get("notes/x.md"), "edited");
  });
  await test("acknowledgement lost, then local edit: retry cannot accept older content", async () => {
    const cloud = new FakeCloud(), client = cloud.client("a"), a = device(cloud, "a", scope(), client); await a.engine.start();
    const put = client.putSmall; let fail = true; client.putSmall = async file => { const result = await put(file); if (fail) { fail = false; throw new CloudNetworkError(); } return result; };
    a.fs.files.set("notes/x.md", "before"); a.engine.noteVaultChange("notes/x.md", "create"); await a.engine.flush();
    a.fs.files.set("notes/x.md", "after"); a.engine.noteVaultChange("notes/x.md", "modify"); a.engine.wake(); await a.engine.flush();
    const row = [...cloud.files.values()].find(x => x.path !== "meta/keycheck")!;
    assert.equal(new TextDecoder().decode((await decryptEntry(key, row.bytes!)).body), "after"); assert.equal(a.engine.snapshot().pending, 0);
  });
  await test("mailboxes remain single-writer when EchoInk is unchecked", async () => {
    const cloud = new FakeCloud(), a = device(cloud, "a", scope(["EchoInk"])), b = device(cloud, "b", scope(["EchoInk"]));
    a.fs.files.set("EchoInk/同步数据/devices/a/company.json", "{}"); a.fs.files.set("EchoInk/同步数据/README.md", "local"); a.fs.files.set("EchoInk/同步数据/devices/b/company.json", "foreign");
    await a.engine.start(); await cloud.settle(); cloud.live.clear(); await b.engine.start();
    assert.equal(b.fs.files.get("EchoInk/同步数据/devices/a/company.json"), "{}"); assert.equal(b.fs.files.get("EchoInk/同步数据/README.md"), undefined);
    assert.equal([...cloud.files.values()].filter(x => x.deviceId === "a").length, 2);
  });
  await test("folder deletion event scans and publishes missing child files", async () => {
    const { a, b } = await pair(); a.fs.files.delete("notes/x.md"); a.engine.noteVaultChange("notes", "delete"); await a.engine.flush(); await b.engine.flush(); assert.equal(b.fs.files.get("notes/x.md"), undefined);
  });
  await test("downloaded-file deletion survives restart and commits stay below 200 items", async () => {
    const { cloud, a, b } = await pair(); b.engine.stop(); b.fs.files.delete("notes/x.md");
    const client = cloud.client("b"), commit = client.commit; client.commit = async files => { assert.ok(files.length <= 200); return commit(files); };
    const restarted = device(cloud, "b", scope(), client, b.fs, b.state, b.base); await restarted.engine.start(); await a.engine.flush(); assert.equal(a.fs.files.get("notes/x.md"), undefined);
  });
  await test("live edits arrive both ways within five seconds after initial sync", async () => {
    const cloud = new FakeCloud(), a = device(cloud, "a"), b = device(cloud, "b"); await a.engine.start(); await b.engine.start();
    const latencies: number[] = [];
    for (const [writer, reader, value] of [[a,b,"A"],[b,a,"B"]] as const) {
      const start = Date.now(); writer.fs.files.set("notes/live.md", value); writer.engine.noteVaultChange("notes/live.md", "modify");
      while (reader.fs.files.get("notes/live.md") !== value && Date.now()-start < 5000) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(reader.fs.files.get("notes/live.md"), value); latencies.push(Date.now()-start);
    }
    console.log(JSON.stringify({incrementalFakeCloudMs:latencies}));
  });
  await test("controller persists enabled state and verified key before first batch, then resumes", async () => {
    const cloud = new FakeCloud(), client = cloud.client("a"), fs = new DeviceVault(), base = memoryBase(), local = new Map<string, unknown>();
    const settings = normalizeCloudSyncSettings(undefined); let saves = 0, failed = false; const put = client.putSmall;
    client.putSmall = async file => { if (file.path !== "meta/keycheck" && !failed) { assert.equal(settings.enabled, true); assert.ok(saves > 0); assert.ok([...local.keys()].some(key => key.startsWith("echoink-cloud-sync-key-v1:"))); failed = true; throw new CloudNetworkError(); } return put(file); };
    const make = () => new CloudSyncController({ fs, base, timers, deviceId: "a", deviceKind: "desktop", defaultDeviceName: "fixture", settings: () => settings,
      session: () => ({ apiUrl: "https://fixture.invalid", token: "synthetic", accountId: "controller-fixture", deviceId: "a", passwordSet: true }),
      saveSettings: async () => { saves++; }, local: { load: key => local.get(key) ?? null, save: (key, value) => { local.set(key, value); } },
      clientFactory: () => client, transport: { json: async () => { throw new Error("fixture client required"); }, putBytes: async () => 500, getBytes: async () => ({ status: 500, bytes: new Uint8Array() }) } });
    fs.files.set("notes/x.md", "local"); const first = make();
    try { await first.enable("synthetic-controller-password"); assert.equal(first.view().enabled, true); assert.equal(first.view().status?.phase, "offline"); } finally { first.dispose(); }
    const resumed = make(); try { await resumed.start(); assert.equal(resumed.view().status?.phase, "idle"); assert.equal(cloud.files.size, 2); } finally { resumed.dispose(); }
  });
  if (process.env.ECHOINK_SYNC_LARGE === "1") await test("150 MiB / 512 binary files: interrupted first upload restarts and verifies every file", async () => {
    const started = Date.now(), cloud = new FakeCloud(), client = cloud.client("a"), a = device(cloud, "a", scope(), client), hashes = new Map<string, string>();
    const bytes = new Uint8Array(307_200); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    for (let i = 0; i < 512; i++) { const p = `notes/file-${i}.bin`; await a.fs.writeBinary(p, bytes.buffer); hashes.set(p, await sha256Hex(bytes)); }
    const put = client.putObject; let uploads = 0; client.putObject = async (url, blob) => { if (++uploads === 258) throw new CloudNetworkError(); await put(url, blob); };
    await a.engine.start(); assert.equal(a.engine.snapshot().phase, "offline"); a.engine.stop(); cloud.live.clear();
    const resumed = device(cloud, "a", scope(), undefined, a.fs, a.state, a.base); await resumed.engine.start(); await cloud.settle(); cloud.live.clear(); const b = device(cloud, "b"); await b.engine.start();
    for (const [p, hash] of hashes) assert.equal(await sha256Hex(new Uint8Array(await b.fs.readBinary(p))), hash, p);
    assert.equal(b.fs.binaries.size, 512); console.log(JSON.stringify({ largeVault: { files: 512, bytes: bytes.length * 512, interruptionAt: 258, elapsedMs: Date.now() - started, missing: 0 } }));
  });

  // ---- Realtime sync: hot queue, batches, conflicts (2026-11-19) ----
  const memoryHistoryFs = (): CloudHistoryFs => {
    const text = new Map<string, string>(), bin = new Map<string, Uint8Array>(), dirs = new Set<string>();
    return { exists: async p => text.has(p) || bin.has(p) || dirs.has(p), mkdir: async p => { dirs.add(p); }, read: async p => text.get(p) ?? "", write: async (p, d) => { text.set(p, d); },
      readBinary: async p => new Uint8Array(bin.get(p)!).buffer, writeBinary: async (p, d) => { bin.set(p, new Uint8Array(d)); }, remove: async p => { text.delete(p); bin.delete(p); } };
  };
  await test("realtime: an edited note goes up before a 100-file backlog, the backlog goes in batches", async () => {
    const cloud = new FakeCloud(), a = device(cloud, "a"); await a.engine.start(); cloud.calls = [];
    for (let i = 0; i < 100; i++) a.fs.files.set(`backlog/${i}.md`, `file ${i}`);
    a.fs.files.set("notes/today.md", "typed just now");
    changeScope(a, []); a.engine.noteVaultChange("notes/today.md", "modify"); await a.engine.flush();
    const uploads = cloud.calls.filter(c => c === "putSmall" || c === "putBatch");
    assert.equal(uploads[0], "putSmall", "the user's edit is the first upload");
    assert.equal(cloud.calls.filter(c => c === "putBatch").length, 2, "100 small files take two batches of at most 64");
    assert.equal(a.engine.snapshot().pending, 0);
    const b = device(cloud, "b"); await b.engine.start(); assert.equal(b.fs.files.get("backlog/99.md"), "file 99"); assert.equal(b.fs.files.get("notes/today.md"), "typed just now");
  });
  await test("realtime: a bulk import of 40 new files sends only the latest few one by one, the rest in a batch", async () => {
    const cloud = new FakeCloud(), a = device(cloud, "a"); await a.engine.start(); cloud.calls = [];
    for (let i = 0; i < 40; i++) { a.fs.files.set(`import/${i}.md`, `n${i}`); a.engine.noteVaultChange(`import/${i}.md`, "create"); }
    await a.engine.flush();
    assert.ok(cloud.calls.filter(c => c === "putSmall").length <= 8); assert.ok(cloud.calls.includes("putBatch")); assert.equal(a.engine.snapshot().pending, 0);
  });
  await test("realtime: an older service without put-batch still receives every file", async () => {
    const cloud = new FakeCloud(); cloud.batch = false; const a = device(cloud, "a");
    for (let i = 0; i < 10; i++) a.fs.files.set(`old/${i}.md`, `v${i}`);
    await a.engine.start(); assert.equal(cloud.calls.filter(c => c === "putBatch").length, 1, "tried once, then remembered");
    assert.equal([...cloud.files.values()].filter(f => f.path !== "meta/keycheck").length, 10); assert.equal(a.engine.snapshot().pending, 0);
  });
  const conflictPair = async (initial = "line one\nline two") => {
    const cloud = new FakeCloud(), ha = new CloudSyncHistory(memoryHistoryFs(), "h"), hb = new CloudSyncHistory(memoryHistoryFs(), "h"), seen: string[] = [];
    const a = device(cloud, "a", scope(), cloud.client("a"), new DeviceVault(), memoryState(), memoryBase(), { history: ha, onConflict: p => seen.push(`a ${p}`) });
    const b = device(cloud, "b", scope(), cloud.client("b"), new DeviceVault(), memoryState(), memoryBase(), { history: hb, onConflict: p => seen.push(`b ${p}`) });
    a.fs.files.set("notes/x.md", initial); await a.engine.start(); await cloud.settle(); await b.engine.start(); await cloud.settle(); await b.engine.flush(); cloud.live.clear();
    return { cloud, a, b, ha, hb, seen };
  };
  await test("conflict: the later edit wins on both devices; the replaced text is in history, no copy beside the note", async () => {
    const { cloud, a, b, ha, hb, seen } = await conflictPair();
    a.fs.files.set("notes/x.md", "line one\nA wrote this"); a.fs.mtimes.set("notes/x.md", 1_000); a.engine.noteVaultChange("notes/x.md", "modify");
    b.fs.files.set("notes/x.md", "line one\nB wrote this later"); b.fs.mtimes.set("notes/x.md", 2_000); b.engine.noteVaultChange("notes/x.md", "modify");
    await a.engine.flush(); await cloud.settle(); await b.engine.flush(); await cloud.settle(); await a.engine.flush(); await cloud.settle(); await b.engine.flush();
    assert.equal(a.fs.files.get("notes/x.md"), "line one\nB wrote this later"); assert.equal(b.fs.files.get("notes/x.md"), "line one\nB wrote this later");
    assert.equal(copies(a).length + copies(b).length, 0, "no conflict copies");
    const [kept] = await ha.list("notes/x.md"); assert.equal(new TextDecoder().decode(await ha.read(kept.id)), "line one\nA wrote this"); assert.equal(kept.deviceName, "a");
    assert.equal(await ha.hasUnseen("notes/x.md"), true); await ha.markSeen("notes/x.md"); assert.equal(await ha.hasUnseen("notes/x.md"), false);
    assert.equal((await hb.list("notes/x.md")).length, 1, "B also keeps the version it rejected");
    assert.ok(seen.includes("a notes/x.md"));
  });
  await test("conflict: when the earlier edit reached the cloud last, every device still ends on the later edit", async () => {
    const { cloud, a, b } = await conflictPair();
    b.fs.files.set("notes/x.md", "line one\nB wrote this first"); b.fs.mtimes.set("notes/x.md", 1_000); b.engine.noteVaultChange("notes/x.md", "modify");
    a.fs.files.set("notes/x.md", "line one\nA wrote this later"); a.fs.mtimes.set("notes/x.md", 2_000); a.engine.noteVaultChange("notes/x.md", "modify");
    await a.engine.flush(); await cloud.settle(); await b.engine.flush(); await cloud.settle(); await a.engine.flush(); await cloud.settle(); await b.engine.flush(); await cloud.settle(); await a.engine.flush();
    assert.equal(a.fs.files.get("notes/x.md"), "line one\nA wrote this later"); assert.equal(b.fs.files.get("notes/x.md"), "line one\nA wrote this later");
    const c = device(cloud, "c"); await c.engine.start(); assert.equal(c.fs.files.get("notes/x.md"), "line one\nA wrote this later", "a third device sees the winner too");
  });
  await test("restoring a conflict version is a new edit that syncs to the winning device", async () => {
    const { cloud, a, b, hb } = await conflictPair();
    const path = "notes/x.md", older = "line one\nB edited first", newer = "line one\nA edited later";
    const edit = (device: typeof a, text: string, mtime: number) => {
      device.fs.files.set(path, text);
      device.fs.mtimes.set(path, mtime);
      device.engine.noteVaultChange(path, "modify");
    };
    edit(b, older, 1_000);
    edit(a, newer, 2_000);
    await b.engine.flush();
    await a.engine.flush();
    await b.engine.flush();
    assert.equal(a.fs.files.get(path), newer);
    assert.equal(b.fs.files.get(path), newer);
    const [previous] = await hb.list(path);
    edit(b, new TextDecoder().decode(await hb.read(previous.id)), 3_000);
    await b.engine.flush();
    await a.engine.flush();
    await cloud.settle();
    assert.equal(a.fs.files.get(path), older);
    assert.equal(b.fs.files.get(path), older);
  });
  await test("conflict: different paragraphs still merge, nothing goes to history", async () => {
    const { cloud, a, b, ha, hb } = await conflictPair("line one\n\nline two");
    a.fs.files.set("notes/x.md", "line one A\n\nline two"); a.engine.noteVaultChange("notes/x.md", "modify"); await a.engine.flush(); await cloud.settle();
    b.fs.files.set("notes/x.md", "line one\n\nline two B"); b.engine.noteVaultChange("notes/x.md", "modify"); await b.engine.flush(); await cloud.settle(); await a.engine.flush();
    const merged = b.fs.files.get("notes/x.md")!; assert.ok(merged.includes("line one A") && merged.includes("line two B"), "both edits kept"); assert.equal(a.fs.files.get("notes/x.md"), merged);
    assert.equal((await ha.list("notes/x.md")).length + (await hb.list("notes/x.md")).length, 0);
  });
  await test("history keeps at most 10 versions per note, newest first", async () => {
    let clock = 0; const h = new CloudSyncHistory(memoryHistoryFs(), "h", () => ++clock);
    for (let i = 0; i < 13; i++) await h.add("n.md", new TextEncoder().encode(`v${i}`), { editedAt: i, deviceName: "a" });
    const list = await h.list("n.md"); assert.equal(list.length, HISTORY_PER_FILE); assert.equal(new TextDecoder().decode(await h.read(list[0].id)), "v12");
    await h.rename("n.md", "m.md"); assert.equal((await h.list("m.md")).length, HISTORY_PER_FILE); assert.equal((await h.list("n.md")).length, 0);
  });

  // ---- Folders: empty folders sync, deleted folders leave nothing behind (2026-11-19) ----
  const folderExists = async (d: Device, path: string) => d.fs.folders.has(path) || [...d.fs.files.keys()].some(k => k.startsWith(`${path}/`));
  await test("folders: a new empty folder appears on the other device, and goes when deleted", async () => {
    const { cloud, a, b } = await pair();
    a.fs.folders.add("空文件夹"); a.engine.noteVaultChange("空文件夹", "create"); await a.engine.flush(); await cloud.settle(); await b.engine.flush();
    assert.equal(await folderExists(b, "空文件夹"), true, "the empty folder exists on B");
    a.fs.folders.delete("空文件夹"); a.engine.noteVaultChange("空文件夹", "delete"); await a.engine.flush(); await cloud.settle(); await b.engine.flush();
    assert.equal(await folderExists(b, "空文件夹"), false, "deleting it on A removes it on B");
  });
  await test("folders: deleting a folder with notes leaves no empty folder on the other device", async () => {
    const { cloud, a, b } = await pair();
    for (const n of ["1", "2"]) { a.fs.files.set(`批量/子/${n}.md`, n); a.engine.noteVaultChange(`批量/子/${n}.md`, "create"); }
    await a.engine.flush(); await cloud.settle(); await b.engine.flush();
    assert.equal(b.fs.files.get("批量/子/1.md"), "1");
    for (const n of ["1", "2"]) a.fs.files.delete(`批量/子/${n}.md`); a.fs.folders.delete("批量/子"); a.fs.folders.delete("批量");
    a.engine.noteVaultChange("批量", "delete"); await a.engine.flush(); await cloud.settle(); await b.engine.flush();
    assert.equal(await folderExists(b, "批量/子"), false); assert.equal(await folderExists(b, "批量"), false, "the emptied parents go too");
  });
  await test("folders: emptying a folder but keeping it keeps it on the other device; unrelated empty folders are untouched", async () => {
    const { cloud, a, b } = await pair();
    a.fs.files.set("保留/a.md", "a"); a.engine.noteVaultChange("保留/a.md", "create"); await a.engine.flush(); await cloud.settle(); await b.engine.flush();
    b.fs.folders.add("B自己的空文件夹");
    a.fs.files.delete("保留/a.md"); a.fs.folders.add("保留"); a.engine.noteVaultChange("保留/a.md", "delete");
    await a.engine.flush(); await cloud.settle(); await b.engine.flush(); await cloud.settle(); await b.engine.flush();
    assert.equal(b.fs.files.has("保留/a.md"), false); assert.equal(await folderExists(b, "保留"), true, "A kept the empty folder, so B keeps it");
    assert.equal(await folderExists(b, "B自己的空文件夹"), true);
  });
  await test("folders: an excluded folder is neither published nor created", async () => {
    const cloud = new FakeCloud(), a = device(cloud, "a", scope(["私密"])), b = device(cloud, "b");
    a.fs.folders.add("私密"); a.fs.folders.add("私密/更深"); await a.engine.start(); await cloud.settle(); await b.engine.start();
    assert.equal(await folderExists(b, "私密/更深"), false); assert.equal(await folderExists(b, "私密"), false);
  });
  console.log(JSON.stringify({ wholeVault: { passed, failed: failures.length, failures } }));
  if (failures.length) throw new Error(`${failures.length} whole-vault regressions failed`);
}
