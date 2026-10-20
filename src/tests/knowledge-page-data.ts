import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { App } from "obsidian";
import { aggregateKnowledgePageActivity, loadKnowledgePageData, type KnowledgePageHost } from "../home/knowledge-page-data";
import { emptyKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { registerKnowledgeFolderBindings } from "../knowledge-base/root-paths";
import { extractMachineSourceMarkers } from "../knowledge-base/knowledge-maintenance-protocol";
import { KnowledgeLinkHealthService } from "../knowledge-base/link-health";
import { loadKnowledgeSourceHealth } from "../knowledge-base/source-health";
import type { KnowledgeBaseDashboardSnapshot } from "../knowledge-base/dashboard";
import type { KnowledgeMaintenanceRecord } from "../knowledge-base/maintenance-record";
import type { KnowledgeBaseMaintenanceHistoryEntry, KnowledgeBaseSettings } from "../settings/settings";

const at = (value: string): number => new Date(value).getTime();
const entry = (runId: string, date: string, overrides: Partial<KnowledgeBaseMaintenanceHistoryEntry> = {}): KnowledgeBaseMaintenanceHistoryEntry => ({ runId, date: date.slice(0, 10), at: at(date), status: "success", mode: "maintain", reportPath: "", ...overrides });
const marker = (source: string, revision = `sha256:${"a".repeat(64)}`): string => `<!-- echoink-source: ${JSON.stringify({ path: source, revision })} -->`;

export async function runKnowledgePageDataTests(testRoot: string): Promise<void> {
  const now = at("2026-01-04T18:00:00-08:00"); // Sunday: this week begins in the previous year.
  const monday = at("2025-12-29T00:00:00-08:00");
  const history = [
    entry("completed", "2025-12-29T00:00:00-08:00", { resultStatus: "completed" }),
    entry("noop", "2026-01-01T10:00:00-08:00", { resultStatus: "noop" }),
    entry("partial", "2026-01-01T10:00:00-08:00", { resultStatus: "partial" }),
    entry("failed", "2026-01-01T10:00:00-08:00", { status: "failed", resultStatus: "failed" }),
    entry("uncertain", "2026-01-01T10:00:00-08:00", { resultStatus: "write_uncertain" }),
    entry("cancel", "2026-01-01T10:00:00-08:00", { status: "canceled", resultStatus: "cancelled" }),
    entry("legacy", "2026-01-02T10:00:00-08:00"),
    entry("legacy-date", "2026-01-03T10:00:00-08:00", { at: 0 }),
    entry("dateless", "2026-01-03T10:00:00-08:00", { at: 0, date: "" }),
    entry("invalid-date", "2026-01-03T10:00:00-08:00", { at: 0, date: "2026-02-30" }),
    entry("future", "2026-01-05T10:00:00-08:00"),
    entry("old", "2024-01-01T10:00:00-08:00"),
    entry("legacy-partial", "2026-01-02T10:00:00-08:00", { completion: "partial" })
  ];
  const data = aggregateKnowledgePageActivity([
    { path: "wiki/start.md", mtime: now, birthtime: monday },
    { path: "wiki/start.md", mtime: now, birthtime: monday },
    { path: "wiki/sunday.md", mtime: now, birthtime: monday - 1 },
    { path: "wiki/edited.md", mtime: now, birthtime: at("2024-01-01T00:00:00-08:00") },
    { path: "wiki/unknown.md", mtime: now, birthtime: null }
  ], [...history, history[0]], now);
  assert.equal(data.weekly.weekStart, monday);
  assert.equal(data.weekly.added, 1, "birthtime only; edits, unknown timestamps and overlaps do not create additions");
  assert.equal(data.weekly.organized, 4, "only completed/noop and reliable legacy successes count once");
  assert.equal(data.weekly.unknownCreatedAtCount, 1);
  assert.deepEqual(data.activityDays.find(day => day.date === "2025-12-29"), { date: "2025-12-29", added: 1, organized: 1, total: 2 });
  assert.ok(data.activityDays.some(day => day.date === "2024-01-01"), "old event years remain available to range selectors");
  assert.equal(aggregateKnowledgePageActivity([], [], at("2026-03-09T00:30:00-07:00")).weekly.weekStart, at("2026-03-09T00:00:00-07:00"), "week boundary survives daylight saving time");
  for (const mode of ["maintain", "reingest", "inbox", "lint", "outputs", "unknown"] as const) {
    const qualifies = ["maintain", "reingest", "inbox", "outputs"].includes(mode);
    for (const resultStatus of [undefined, "completed", "noop"] as const) {
      const modeData = aggregateKnowledgePageActivity([], [entry(`mode-${mode}-${resultStatus}`, "2026-01-01T10:00:00-08:00", { mode, resultStatus })], now);
      assert.equal(modeData.weekly.organized, qualifies ? 1 : 0, `${mode}/${resultStatus ?? "legacy-success"}: only proven organization modes count`);
      assert.equal(modeData.activityDays.reduce((total, day) => total + day.organized, 0), qualifies ? 1 : 0, "heatmap and weekly figures use the same mode boundary");
    }
  }

  const vaultPath = path.join(testRoot, "vault");
  await fsp.mkdir(vaultPath);
  const write = async (relative: string, text = "synthetic"): Promise<void> => { await fsp.mkdir(path.dirname(path.join(vaultPath, relative)), { recursive: true }); await fsp.writeFile(path.join(vaultPath, relative), text); };
  let bindings = emptyKnowledgeFolderBindings();
  for (const [role, roots] of Object.entries({ raw: ["sources", "sources/nested"], wiki: ["wiki", "wiki/sub"], projects: ["projects", "projects/a"], inbox: ["inbox", "lost-inbox"] })) {
    bindings.roles[role as "raw" | "wiki" | "projects" | "inbox"] = { enabled: true, readPaths: roots, writePath: roots[0], allowedSubdirectories: [], compatibilityReadScopes: true };
  }
  const unregister = registerKnowledgeFolderBindings(vaultPath, () => bindings);
  let linkService: KnowledgeLinkHealthService | null = null;
  try {
    await write("sources/existing.md", "source revision has changed");
    await write("sources/nested/one.pdf");
    await write("sources/not-supported.exe");
    await write("wiki/missing.md", marker("sources/missing.md"));
    await write("wiki/changed.md", marker("sources/existing.md"));
    await write("wiki/old.md", "[[sources/ordinary-missing.md]]");
    await write("wiki/invalid.md", marker("../outside.md") + marker("sources/invalid.md", "bad-revision"));
    await write("wiki/unbound.md", marker("old-sources/missing.md"));
    await write("wiki/sub/linked.md");
    await write("wiki-prefix/excluded.md");
    await write("outside/incoming.md", "[[wiki/sub/linked]]");
    await write("projects/a/child.md");
    await fsp.mkdir(path.join(vaultPath, "projects/a/deep"));
    await fsp.mkdir(path.join(vaultPath, "projects/b"));
    await write("inbox/idea.md");
    assert.deepEqual([...extractMachineSourceMarkers(marker("sources/missing.md") + "\n[[sources/manual.md]]").keys()], ["sources/missing.md"], "machine evidence is distinct from hand-written links");
    const sources = await loadKnowledgeSourceHealth(vaultPath, bindings, ["wiki/missing.md", "wiki/changed.md", "wiki/old.md", "wiki/invalid.md", "wiki/unbound.md", "wiki/read-failed.md"]);
    assert.deepEqual(sources.missing, [{ path: "wiki/missing.md", sourcePaths: ["sources/missing.md"] }]);
    assert.equal(sources.unknownCount, 4, "no marker, invalid/unbound marker and read failure remain unknown");
    const strictCases = [
      { name: "extra-field", invalid: true, content: `<!-- echoink-source: ${JSON.stringify({ path: "sources/missing.md", revision: `sha256:${"a".repeat(64)}`, extra: true })} -->` },
      { name: "conflicting-revisions", invalid: true, content: `${marker("sources/missing.md")}\n${marker("sources/missing.md", `sha256:${"b".repeat(64)}`)}` },
      { name: "mixed-malformed", invalid: true, content: `${marker("sources/missing.md")}\n<!-- echoink-source: not-json -->` },
      { name: "mixed-invalid-json", invalid: true, content: `${marker("sources/missing.md")}\n<!-- echoink-source: {"path": } -->` },
      { name: "no-marker", invalid: false, content: "# Legacy note without machine evidence" },
      { name: "ordinary-link", invalid: false, content: "[[sources/missing.md]]" }
    ];
    const wikiRoots = bindings.roles.wiki.readPaths;
    bindings.roles.wiki.readPaths = [...wikiRoots, "strict-cases"];
    try {
      for (const testCase of strictCases) {
        const relative = `strict-cases/${testCase.name}.md`;
        await write(relative, testCase.content);
        if (testCase.invalid) assert.throws(() => extractMachineSourceMarkers(testCase.content), /knowledge_candidate_source_marker/u, "formal parser rejects the entire invalid marker set");
        else assert.equal(extractMachineSourceMarkers(testCase.content).size, 0, "human links alone are not machine evidence");
        const checked = await loadKnowledgeSourceHealth(vaultPath, bindings, [relative]);
        assert.deepEqual(checked, { state: "unknown", missing: [], unknownCount: 1, checkedCount: 0 }, `${testCase.name} cannot become a missing-source problem`);
      }
    } finally { bindings.roles.wiki.readPaths = wikiRoots; }
    await fsp.symlink(path.join(vaultPath, "sources/existing.md"), path.join(vaultPath, "sources/symlink.md"));
    await write("wiki/symlink.md", marker("sources/symlink.md"));
    assert.equal((await loadKnowledgeSourceHealth(vaultPath, bindings, ["wiki/symlink.md"])).missing.length, 0, "unsafe targets are unknown rather than missing");

    const filePaths = ["wiki/missing.md", "wiki/changed.md", "wiki/old.md", "wiki/invalid.md", "wiki/unbound.md", "wiki/sub/linked.md", "wiki/symlink.md", "projects/a/child.md", "outside/incoming.md"];
    const graph = Object.fromEntries(filePaths.map(file => [file, {} as Record<string, number>]));
    graph["outside/incoming.md"] = { "wiki/sub/linked.md": 1 };
    graph["wiki/old.md"] = { "wiki/old.md": 1, "sources/nested/one.pdf": 1 };
    const app = { vault: { adapter: { getBasePath: () => vaultPath }, getMarkdownFiles: () => filePaths.map(file => ({ path: file })) },
      metadataCache: { resolvedLinks: graph, on: () => ({}), offref() {}, getFileCache: () => ({}) }, workspace: { layoutReady: true } } as unknown as App;
    linkService = new KnowledgeLinkHealthService(app);
    const sharedLinks = await linkService.load(bindings);
    assert.ok(!sharedLinks.isolatedPaths.includes("wiki/sub/linked.md"), "incoming links from outside the knowledge range count");
    assert.ok(sharedLinks.isolatedPaths.includes("wiki/old.md"), "self and attachment links do not count");
    const health = { score: 73, status: "risk", assessment: "limited" } as KnowledgeBaseDashboardSnapshot["health"];
    const privateFailure = { schemaVersion: 1, recordId: "private", runId: "override", at: Date.now(), date: "2026-10-18", cancelled: false,
      result: { status: "failed", issues: [] }, sources: [], summary: "failed" } as unknown as KnowledgeMaintenanceRecord;
    const host: KnowledgePageHost = { app, settings: { knowledgeBase: { folderBindings: bindings, maintenanceHistory: [entry("override", new Date().toISOString())] } as KnowledgeBaseSettings },
      settingsKnowledgeBindings: () => bindings,
      getKnowledgeSurfaceService: () => ({ getDashboardSnapshot: async () => ({ health } as KnowledgeBaseDashboardSnapshot), getMaintenanceRecords: async () => [privateFailure] }) };
    const snapshot = await loadKnowledgePageData(host, async () => sharedLinks, Date.now() + 1000);
    assert.strictEqual(snapshot.health, health, "health projection preserves the dashboard score and assessment");
    assert.strictEqual(snapshot.links, sharedLinks, "the knowledge page consumes the workbench service result");
    assert.equal(snapshot.weekly.organized, 0, "private failure supersedes the successful settings copy");
    assert.equal(snapshot.directories.find(directory => directory.role === "raw")?.count, 2, "supported formats and overlapping roots deduplicate");
    assert.equal(snapshot.directories.find(directory => directory.role === "wiki")?.count, 7, "scope matches directory boundaries");
    assert.equal(snapshot.directories.find(directory => directory.role === "projects")?.count, 3, "project count uses immediate child folders across legacy roots");
    const inbox = snapshot.directories.find(directory => directory.role === "inbox")!;
    assert.equal(inbox.state, "partial"); assert.equal(inbox.count, 1); assert.equal(inbox.roots[1].count, null, "missing roots never become zero");
    assert.equal(snapshot.weekly.added, 7, "real file birthtime reaches the current week's figures");
    const failed = await loadKnowledgePageData({ ...host, getKnowledgeSurfaceService: () => ({ getDashboardSnapshot: async () => { throw new Error("health unavailable"); }, getMaintenanceRecords: async () => { throw new Error("history unavailable"); } }) }, async () => { throw new Error("resolver unavailable"); });
    assert.equal(failed.health, null); assert.equal(failed.weekly.organized, null); assert.equal(failed.weekly.added, 7);
    assert.equal(failed.links.state, "unknown"); assert.ok(failed.errors.health && failed.errors.history && failed.errors.links);
    assert.ok(failed.errors.activity, "unavailable authoritative history cannot appear as a complete activity heatmap");
    bindings.roles.raw.readPaths = ["removed-source-root"];
    assert.equal((await loadKnowledgeSourceHealth(vaultPath, bindings, ["wiki/missing.md"])).missing.length, 0, "unbinding a source cannot manufacture a missing-file alert");

    bindings = emptyKnowledgeFolderBindings();
    bindings.roles.wiki = { enabled: true, readPaths: ["bulk", "bulk/deep"], writePath: "bulk", allowedSubdirectories: [], compatibilityReadScopes: true };
    await Promise.all(Array.from({ length: 1000 }, (_, index) => write(`bulk/deep/note-${index}.md`, `# Synthetic ${index}`)));
    let turns = 0;
    const timer = setInterval(() => { turns++; }, 0);
    const started = performance.now();
    let bulk: Awaited<ReturnType<typeof loadKnowledgePageData>>;
    try { bulk = await loadKnowledgePageData(host, async () => ({ state: "unknown", candidatePaths: [], isolatedPaths: [], reason: "解析中" }), Date.now() + 1000); }
    finally { clearInterval(timer); }
    assert.equal(bulk.directories.find(directory => directory.role === "wiki")?.count, 1000);
    assert.equal(bulk.weekly.added, 1000);
    assert.equal(bulk.activityDays.reduce((total, day) => total + day.added, 0), 1000);
    assert.ok(turns >= 10, "large real-file scans yield to the event loop");
    assert.equal(bulk.sources.missing.length, 0, "unmarked legacy notes are not source problems");
    console.log(`P8 data: calendar/status/dedupe/source boundaries and independent errors passed; 1000 real files in ${Math.round(performance.now() - started)}ms, ${turns} event-loop turns.`);
  } finally { linkService?.dispose(); unregister(); }
}
