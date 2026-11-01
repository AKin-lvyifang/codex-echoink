import assert from "node:assert/strict";
import { TFile, TFolder, type App } from "obsidian";
import { JOURNAL_FORMAT_PRESETS, journalFormatError, parseJournalDate, preferredJournalPath } from "../home/journal-format";
import { buildJournalPlan, parseJournalOrganizationRecord } from "../home/journal-organization";
import { JournalFormatService } from "../home/journal-format-service";
import { readNativeJournalSettings, saveNativeJournalFormat, loadNativeJournalSettings, nativeRootJournalPaths } from "../home/native-journal";
import { VaultBodySearch, knowledgeSearchPathKind } from "../knowledge-base/vault-body-search";
import { emptyKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { sha256Hex } from "../utils/sha256";

function fixture(format = "YYYY-MM/YYYY-MM-DD", folder = "Daily") {
  const files = new Map<string, any>(), bytes = new Map<string, string>(); let tick = 1, failMovedRecord = false, failRestoredRecord = false, linksEnabled = true;
  const daily: Record<string, unknown> = { folder, format, template: "" }, saved = { ...daily };
  const makeFolder = (path: string) => { const file = new TFolder(); Object.assign(file, { path, name: path.split("/").at(-1), children: [] }); files.set(path, file); return file; };
  const add = (path: string, content = "journal") => { const file = new TFile(path); Object.assign(file, { path, basename: path.split("/").at(-1)!.replace(/\.md$/u, ""), extension: "md", stat: { mtime: tick++, size: content.length, ctime: 1 } }); files.set(path, file); bytes.set(path, content); return file; };
  if (folder) makeFolder(folder);
  const adapter = {
    exists: async (path: string) => bytes.has(path) || files.has(path), mkdir: async (path: string) => { makeFolder(path); },
    read: async (path: string) => { if (!bytes.has(path)) throw new Error("missing"); return bytes.get(path)!; },
    write: async (path: string, content: string) => { if (failRestoredRecord && path.endsWith(".tmp") && content.includes('"state":"restored"')) { failRestoredRecord = false; throw new Error("interrupted undo persistence"); } if (failMovedRecord && path.endsWith(".tmp") && content.includes('"state":"moved"')) { failMovedRecord = false; throw new Error("interrupted persistence"); } bytes.set(path, content); },
    rename: async (from: string, to: string) => { assert.ok(bytes.has(from)); bytes.set(to, bytes.get(from)!); bytes.delete(from); },
    remove: async (path: string) => { bytes.delete(path); }
  };
  const app = {
    internalPlugins: { plugins: { "daily-notes": { enabled: true, instance: { options: daily }, loadData: async () => saved, saveData: async (value: any) => { Object.assign(saved, value); } }, templates: { enabled: true, instance: { options: {} }, loadData: async () => ({}) } } },
    vault: { adapter, configDir: ".obsidian", getRoot: () => ({ children: [...files.values()] }), getAbstractFileByPath: (path: string) => files.get(path) ?? null,
      getMarkdownFiles: () => [...files.values()].filter(file => file instanceof TFile && file.extension === "md"), getFiles: () => [...files.values()].filter(file => file instanceof TFile), getAllLoadedFiles: () => [...files.values()],
      getConfig: () => linksEnabled,
      read: async (file: TFile) => bytes.get(file.path)!, createFolder: async (path: string) => makeFolder(path),
      process: async (file: TFile, change: (value: string) => string) => { bytes.set(file.path, change(bytes.get(file.path)!)); }, trigger: () => {} },
    metadataCache: { getFileCache: () => ({ links: [], embeds: [] }), getFirstLinkpathDest: () => null },
    fileManager: { renameFile: async (file: TFile, to: string) => { const from = file.path; assert.ok(!files.has(to)); files.delete(from); bytes.set(to, bytes.get(from)!); bytes.delete(from); Object.assign(file, { path: to }); files.set(to, file); } }
  } as unknown as App;
  const host = { directory: ".obsidian/plugins/test", settings: () => ({ journalDirectory: folder }), model: () => "Synthetic model",
    generate: async (_system: string, user: string) => { const input = JSON.parse(user); return JSON.stringify({ id: input.id, date: "2026-10-29", evidence: "2026-10-29" }); }, changed: () => {} };
  return { app, files, bytes, add, daily, saved, host, fail: () => { failMovedRecord = true; }, failUndo: () => { failRestoredRecord = true; }, disableLinks: () => { linksEnabled = false; }, service: () => new JournalFormatService(app, host) };
}
export async function runJournalFormatTests() {
  for (const format of JOURNAL_FORMAT_PRESETS) assert.equal(journalFormatError(format), null);
  for (const [format, reason] of [["", "empty"], ["YYYY-MM", "date"], ["[YYYY-MM-DD]", "date"], ["../YYYY-MM-DD", "path"], [".obsidian/YYYY-MM-DD", "path"], ["/YYYY-MM-DD", "path"], ['YYYY-MM-DD:*', "path"], ["YYYY-MM-DD HHmm", "time"], ["YYYY-MM-DD.md", "path"]]) assert.equal(journalFormatError(format), reason, format);
  assert.equal(parseJournalDate("Daily/2026/10/2026-10-31.md", "Daily", "YYYY-MM-DD"), "2026-10-31");
  assert.equal(parseJournalDate("Daily/20261031.md", "Daily"), "2026-10-31");
  assert.equal(parseJournalDate("Daily/2026-02-30.md", "Daily"), null);
  assert.equal(parseJournalDate("Daily/archive/2026-10-31.md", "Daily"), null);
  assert.equal(parseJournalDate("Daily/2026年10月31日.md", "Daily", "YYYY-MM-DD", ["YYYY年MM月DD日"]), "2026-10-31");
  assert.equal(preferredJournalPath(["Daily/2026-10-31.md", "Daily/2026-10/2026-10-31.md"], new Date(2026, 9, 31), "Daily", "YYYY-MM/YYYY-MM-DD"), "Daily/2026-10/2026-10-31.md");
  const input = { folder: "Daily", format: "YYYY-MM/YYYY-MM-DD", signature: "s", files: ["Daily/2026-10-15.md", "Daily/20261015.md", "Daily/2026-10-16.md", "Daily/随便写写.md"].map(path => ({ path, version: "1" })) };
  const plan = buildJournalPlan(input); assert.equal(plan.keep.length, 2); assert.equal(plan.moves.length, 1); assert.equal(plan.unknown.length, 1);
  const occupied = buildJournalPlan({ ...input, occupied: ["Daily/2026-10"] }); assert.equal(occupied.moves.length, 0); assert.ok(occupied.keep.some(item => item.reason === "parent"));
  const folderCollision = buildJournalPlan({ ...input, directories: ["Daily/2026-10/2026-10-16.md"] }); assert.equal(folderCollision.moves.length, 0); assert.ok(folderCollision.keep.some(item => item.reason === "occupied"));
  const root = buildJournalPlan({ folder: "", format: "YYYY-MM/YYYY-MM-DD", signature: "r", files: [{ path: "2026-10-31.md", version: "1" }, { path: "Project.md", version: "1" }, { path: "My journal.md", version: "1", journalHint: true }] });
  assert.equal(root.moves.length, 1); assert.deepEqual(root.unknown.map(file => file.path), ["My journal.md"]);
  const large = buildJournalPlan({ folder: "Daily", format: "YYYY-MM/YYYY-MM-DD", signature: "large", files: Array.from({ length: 1200 }, (_, i) => ({ path: `Daily/${new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10)}.md`, version: "1" })) });
  assert.equal(large.moves.length, 1200); assert.equal(large.keep.length, 0);
  const searchable = fixture("YYYY年MM月DD日", "Daily"); searchable.add("Daily/2026年10月29日.md", "synthetic range-needle");
  const bindings = emptyKnowledgeFolderBindings(); Object.assign(bindings.roles.journal, { native: true, enabled: true, searchEnabled: true, readPaths: ["Daily"], writePath: "Daily" });
  bindings.roles.journal.readPaths = ["Previous journal folder"];
  bindings.roles.journal.writePath = "Previous journal folder";
  const search = new VaultBodySearch(searchable.app, () => bindings);
  assert.equal((await search.search({ query: "range-needle", kinds: ["journal"], dateFrom: "2026-10-29", dateTo: "2026-10-29" })).hits[0]?.vaultRelativePath, "Daily/2026年10月29日.md");
  await saveNativeJournalFormat(searchable.app, "YYYY-MM-DD");
  assert.equal((await search.search({ query: "range-needle", kinds: ["journal"], dateFrom: "2026-10-29", dateTo: "2026-10-29" })).hits.length, 1, "History changes invalidate the date scope without hiding old journals");
  assert.equal(knowledgeSearchPathKind("2026年10月29日.md", null, [], { folder: "", format: "YYYY年MM月DD日", formatHistory: [] }), "journal");
  bindings.roles.journal.readPaths = []; bindings.roles.journal.writePath = null;
  assert.equal(knowledgeSearchPathKind("2026年10月29日.md", bindings, [], { folder: "", format: "YYYY年MM月DD日", formatHistory: [] }), "journal"); search.dispose();
  const f = fixture("", "Daily"); await loadNativeJournalSettings(f.app); assert.equal(readNativeJournalSettings(f.app).format, "YYYY-MM-DD");
  await saveNativeJournalFormat(f.app, "YYYY年MM月DD日"); await saveNativeJournalFormat(f.app, "YYYY-MM-DD");
  assert.ok(readNativeJournalSettings(f.app).formatHistory.includes("YYYY年MM月DD日"));
  const rootFixture = fixture("YYYY-MM/YYYY-MM-DD", ""); assert.deepEqual(nativeRootJournalPaths(rootFixture.app, ["2026-10-31.md", "20261030.md", "Other.md"]), ["2026-10-31.md", "20261030.md"]);
  const blocked = fixture(); blocked.add("Daily/2026-10-23.md"); const blocking = blocked.service(); await blocking.preview(); blocked.disableLinks(); await assert.rejects(() => blocking.execute(), /journal_links_disabled/u); assert.equal(blocking.record, null); assert.ok(blocked.files.has("Daily/2026-10-23.md"), "link dependency blocks before any file move");
  const moved = fixture(); moved.add("Daily/2026-10-31.md", "user content"); const service = moved.service(); await service.preview(); await service.execute();
  assert.ok(moved.files.has("Daily/2026-10/2026-10-31.md")); assert.equal(service.record?.entries[0].state, "moved");
  const cold = moved.service(); await cold.initialize(); await cold.undo(); assert.equal(cold.record?.status, "undone"); assert.equal(moved.bytes.get("Daily/2026-10-31.md"), "user content");
  const edited = fixture(); edited.add("Daily/2026-10-30.md"); const editing = edited.service(); await editing.preview(); await editing.execute(); edited.bytes.set("Daily/2026-10/2026-10-30.md", "new user text"); await editing.undo();
  assert.equal(editing.record?.entries[0].reason, "edited"); assert.equal(edited.bytes.get("Daily/2026-10/2026-10-30.md"), "new user text");
  const interrupted = fixture(); interrupted.add("Daily/2026-10-29.md", "saved"); const running = interrupted.service(); await running.preview(); interrupted.fail(); await assert.rejects(() => running.execute());
  const recovered = interrupted.service(); await recovered.initialize(); assert.equal(recovered.record?.status, "interrupted"); await recovered.undo(); assert.equal(interrupted.bytes.get("Daily/2026-10-29.md"), "saved");
  const undoCrash = fixture(); undoCrash.add("Daily/2026-10-24.md", "preserve undo"); const undoing = undoCrash.service(); await undoing.preview(); await undoing.execute(); undoCrash.failUndo(); await assert.rejects(() => undoing.undo());
  const undoRecovered = undoCrash.service(); await undoRecovered.initialize(); assert.equal(undoRecovered.record?.status, "interrupted"); await undoRecovered.undo(); assert.equal(undoRecovered.record?.status, "undone"); assert.equal(undoCrash.bytes.get("Daily/2026-10-24.md"), "preserve undo");
  const replacement = fixture(); replacement.add("Daily/2026-10-26.md"); const replacing = replacement.service(); await replacing.preview(); await replacing.execute();
  const recordPath = ".obsidian/plugins/test/journal-format-moves.v1.json";
  replacement.bytes.set(`${recordPath}.backup`, replacement.bytes.get(recordPath)!);
  const backupRecovery = replacement.service(); await backupRecovery.initialize(); await backupRecovery.undo(); assert.equal(backupRecovery.record?.status, "undone");
  const ai = fixture(); ai.add("Daily/最后一天.md", "2026-10-29\n今天的日记"); const identifying = ai.service(); await identifying.preview(); await identifying.identify(); assert.equal(identifying.plan?.moves[0].date, "2026-10-29");
  const nameAi = fixture(); nameAi.add("Daily/2026-10-29 周四.md", "今天的日记"); const nameIdentifying = nameAi.service(); await nameIdentifying.preview(); await nameIdentifying.identify(); assert.equal(nameIdentifying.plan?.moves[0].date, "2026-10-29", "AI can cite an explicit full date in the filename");
  const changed = fixture(); const source = changed.add("Daily/2026-10-28.md"); const changing = changed.service(); await changing.preview(); source.stat.mtime++; await changing.execute(); assert.equal(changing.record?.keep[0].reason, "changed"); assert.ok(changed.files.has(source.path));
  assert.throws(() => parseJournalOrganizationRecord(JSON.stringify({ schema: 1, id: "test", folder: "", format: "YYYY-MM-DD", signature: "s", status: "done", entries: [{ from: "../private.md", to: "x.md", state: "moved", beforeHash: sha256Hex("x") }], keep: [] })));
  console.log("PASS journal formats: validation, history, native blank, root protection, conflicts, AI, persisted undo, user edits and interrupted moves");
}
