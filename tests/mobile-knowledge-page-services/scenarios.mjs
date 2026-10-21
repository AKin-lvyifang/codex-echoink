import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pageFixture, digest } from "./host.mjs";
const marker = source => `<!-- echoink-source: ${JSON.stringify({ path: source, revision: `sha256:${"a".repeat(64)}` })} -->`;
const same = (actual, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const record = (index, status, extra = {}) => ({ schemaVersion: 1, recordId: `maintenance-${index.toString(16).padStart(32, "0")}`, runId: `run-${index}`, at: Date.now() - 1000, date: new Date().toISOString().slice(0, 10), summary: "Original summary", sources: [{ path: "Sources/a.md", fingerprint: "synthetic", status: "unread", evidencePaths: [] }], result: { schema: "echoink.knowledge-maintenance-result.v1", status, notes: status === "completed" ? [{ operation: "created", path: "Wiki/result.md", title: "Original", summary: "Original" }] : [], issues: status === "partial" ? [{ code: "unread", message: "Unread" }] : [], systemPaths: [] }, ...extra });

export async function runPageScenarios(api, root) {
  const f = await pageFixture(api, path.join(root, "mobile"), {
    "Sources/a.md": "# raw\n", "Sources/nested/b.pdf": "synthetic PDF", "Sources/no.exe": "ignored", "Sources/.hidden/x.md": "hidden",
    "Wiki/missing.md": marker("Sources/missing.md"), "Wiki/changed.md": marker("Sources/a.md"), "Wiki/legacy.md": "[[Sources/manual-missing.md]]",
    "Wiki/sub/linked.md": "# connected", "Wiki/.hidden/note.md": "hidden", "Wiki-prefix/excluded.md": "outside",
    "outside/incoming.md": "[[Wiki/sub/linked]]", "Projects/a/deep/note.md": "# project", "Inbox/idea.md": "# inbox"
  });
  await fs.mkdir(f.full("Projects/b"), { recursive: true });
  const bindings = f.settings.knowledgeBase.folderBindings = api.emptyKnowledgeFolderBindings();
  for (const [role, roots] of Object.entries({ raw: ["Sources", "Sources/nested"], wiki: ["Wiki", "Wiki/sub"], projects: ["Projects", "Projects/a"], inbox: ["Inbox"] })) bindings.roles[role] = { enabled: true, readPaths: roots, writePath: roots[0], allowedSubdirectories: [], compatibilityReadScopes: true };
  f.settings.apiProviders = []; f.settings.activeApiProviderId = "";
  f.resolve({ "outside/incoming.md": { "Wiki/sub/linked.md": 1 } }); await tick(); f.reset();
  let notifications = 0;
  const stop = f.service.subscribe(() => { notifications++; });
  let snap = await f.service.read(); await tick();
  assert.equal(notifications, 0, "read must not invalidate itself");
  same(snap.directories.map(directory => [directory.role, directory.count]), [["raw", 2], ["wiki", 4], ["projects", 3], ["inbox", 1]]);
  assert.equal(snap.weekly.added, 4); assert.equal(snap.weekly.organized, 0); assert.equal(snap.health.score, 100);
  assert.equal(snap.links.state, "ready"); assert.ok(!snap.links.isolatedPaths.includes("Wiki/sub/linked.md"));
  same(snap.sources.missing, [{ path: "Wiki/missing.md", sourcePaths: ["Sources/missing.md"] }]);
  assert.equal(snap.sources.unknownCount, 2); // Unmarked legacy + linked note.
  assert.equal((await f.service.readFolder("Wiki")).files.length, 4);
  await assert.rejects(f.service.readFolder("Wiki-prefix"), /范围/u);
  await assert.rejects(f.service.readFolder("../Wiki"), /相对路径/u);
  f.metadataEvents.emit("changed"); await tick(); snap = await f.service.read();
  assert.equal(snap.links.state, "unknown"); assert.equal(snap.links.isolatedPaths.length, 0);
  f.resolve(); await tick();
  const originalStat = f.adapter.stat.bind(f.adapter);
  f.adapter.stat = async relative => { const value = await originalStat(relative); return relative === "Wiki/legacy.md" ? { ...value, ctime: 0 } : value; };
  snap = await f.service.read(); assert.equal(snap.weekly.added, null); assert.equal(snap.weekly.unknownCreatedAtCount, 1);
  f.adapter.stat = originalStat;
  const originalRead = f.adapter.read.bind(f.adapter);
  f.adapter.read = async relative => { if (relative === "Sources/a.md") throw Error("sync unavailable"); return originalRead(relative); };
  snap = await f.service.read(); assert.equal(snap.health, null); assert.ok(snap.errors.health);
  f.adapter.read = originalRead;
  const originalList = f.adapter.list.bind(f.adapter);
  f.adapter.list = async relative => { if (relative === "Sources") throw Error("source root unreadable"); return originalList(relative); };
  snap = await f.service.read(); assert.equal(snap.directories[0].count, null); assert.equal(snap.health, null);
  f.adapter.list = originalList;
  f.adapter.stat = async relative => { if (relative === "Sources") throw Error("not readable"); return originalStat(relative); };
  snap = await f.service.read(); assert.equal(snap.sources.missing.length, 0, "unreadable source root cannot prove missing");
  f.adapter.stat = originalStat;
  f.settings.knowledgeBase.processedSources["Sources/a.md"] = {}; // Original known-but-unverified record.
  snap = await f.service.read(); assert.equal(snap.health.score, 96); delete f.settings.knowledgeBase.processedSources["Sources/a.md"];
  await f.write("Sources/large.md", "x".repeat(262145)); snap = await f.service.read(); assert.equal(snap.health, null); await fs.unlink(f.full("Sources/large.md"));
  const states = ["completed", "noop", "partial", "failed", "write_uncertain"];
  const records = states.map((status, index) => record(index + 1, status)); records.push(record(6, "completed", { cancelled: true }));
  for (const value of records) await f.record(value);
  f.settings.knowledgeBase.maintenanceHistory = records.map(value => ({ recordId: value.recordId, runId: value.runId, at: value.at, date: value.date, mode: "maintain", status: "success", reportPath: "", resultStatus: "completed" }));
  snap = await f.service.read(); assert.equal(snap.weekly.organized, 2); assert.equal(snap.maintenanceHistory.length, 6);
  same(snap.maintenanceHistory.map(value => value.resultStatus).sort(), ["cancelled", "completed", "failed", "noop", "partial", "write_uncertain"].sort());
  assert.equal((await f.service.readRecord(records[0].recordId)).summary, "Original summary");
  const broken = record(7, "completed"); broken.result.notes = []; await f.record(broken);
  snap = await f.service.read(); assert.equal(snap.weekly.organized, null); assert.equal(snap.maintenanceRecords.length, 6); assert.ok(snap.errors.history);
  await fs.unlink(f.full(`.obsidian/plugins/echoink/pi-agent-product-v1/knowledge/records/${broken.recordId}.json`));
  await fs.unlink(f.full(`.obsidian/plugins/echoink/pi-agent-product-v1/knowledge/records/${records[0].recordId}.json`));
  snap = await f.service.read(); assert.equal(snap.weekly.organized, null, "missing authoritative record cannot leave legacy success as a complete count");
  const host = api.mobileKnowledgeSourcesHost(bindings), selectedSources = [{ relativePath: "Sources/a.md", contentSha256: digest(await f.read("Sources/a.md")) }];
  const completed = api.completeKnowledgeMaintenanceCandidateSources({ targetPath: "Wiki/result.md", content: "# Actual source\n[[Sources/a.md]]", selectedSources }, host);
  assert.equal(api.validateKnowledgeMaintenanceCandidateSources({ targetPath: "Wiki/result.md", content: completed, selectedSources }, host)[0].revision, `sha256:${selectedSources[0].contentSha256}`);
  for (const invalid of [completed.replace(selectedSources[0].contentSha256, "b".repeat(64)), completed + "\n<!-- echoink-source: not-json -->", completed + "\n" + marker("Sources/a.md")]) assert.throws(() => api.validateKnowledgeMaintenanceCandidateSources({ targetPath: "Wiki/result.md", content: invalid, selectedSources }, host), /knowledge_candidate_source_/u);
  await f.service.openGraph(); assert.equal(f.leaves.length, 1); assert.equal(f.leaves[0].type, "tab"); assert.ok(f.leaves[0].cancelled && f.leaves[0].revealed); assert.match(f.leaves[0].options.search, /Wiki/u); assert.match(f.leaves[0].options.search, /Projects/u);
  f.graph.fallback = true; await f.service.openGraph(); assert.equal(f.leaves.length, 3); assert.ok(f.leaves[1].detached && f.leaves[2].revealed); f.graph.fallback = false;
  const before = f.leaves.length;
  f.adapter.stat = async relative => { const value = await originalStat(relative); if (relative === "Wiki") bindings.revision++; return value; };
  await assert.rejects(f.service.openGraph(), /已变化/u); assert.equal(f.leaves.length, before);
  await assert.rejects(f.service.readFolder("Wiki"), /已变化/u);
  f.adapter.stat = originalStat;
  f.adapter.list = async relative => { const value = await originalList(relative); if (relative === "Wiki") bindings.revision++; return value; };
  await assert.rejects(f.service.read(), /已变化/u); f.adapter.list = originalList;
  const aborted = new AbortController(); aborted.abort(); await assert.rejects(f.service.read(aborted.signal), /停止/u);
  stop(); let listenerReads = 0, readDone;
  const done = new Promise(resolve => { readDone = resolve; });
  f.service.subscribe(() => { listenerReads++; void f.service.read().then(readDone); });
  f.vaultEvents.emit("modify"); f.vaultEvents.emit("create"); f.vaultEvents.emit("rename"); await done; await tick();
  assert.equal(listenerReads, 1, "coalesced notifications and subscriber read cannot loop");
  const realReader = f.services.readMaintenanceRecord; let release;
  f.services.readMaintenanceRecord = id => new Promise(resolve => { release = () => realReader(id).then(resolve); });
  const pending = f.service.readRecord(records[1].recordId); f.service.dispose(); release();
  await assert.rejects(pending, /关闭/u); assert.equal(f.vaultEvents.size, 0); assert.equal(f.metadataEvents.size, 0);
  same(f.calls.writes, []); same(f.calls.removes, []); same(f.calls.renames, []); assert.equal(f.calls.model, 0); assert.equal(f.calls.usage, 0);
  console.log("PASS real mobile filesystem: four roles/overlaps/hidden files; ctime/unknown; histories/strict records; actual health/calibration/read budgets; full-Vault links; source unknown/absent/changed; program source revisions; graph/fallback/stale scope; zero writes/Provider; read/subscription/disposal.");
  const now = new Date("2026-01-04T18:00:00-08:00").getTime(), monday = new Date("2025-12-29T00:00:00-08:00").getTime();
  const activity = api.aggregateKnowledgePageActivity([{ path: "Wiki/old.md", mtime: now, birthtime: monday - 1 }, { path: "Wiki/new.md", mtime: 0, birthtime: monday }], [], now);
  assert.equal(activity.weekly.added, 1); assert.equal(activity.weekly.weekStart, monday);
  assert.equal(api.aggregateKnowledgePageActivity([], [], new Date("2026-03-09T00:30:00-07:00").getTime()).weekly.weekStart, new Date("2026-03-09T00:00:00-07:00").getTime());
  console.log("PASS shared activity: creation time only, year boundary and daylight saving time.");
}
