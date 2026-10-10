import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { InitializationDirectoryHistory } from "../knowledge-base/initialization-directory-history";
import { bilingualWikiFolderName, wikiCategoryLabel, wikiFolderNeedsTranslation, optimizeWikiFolderNames, maintenanceRequestsAdviceOnly } from "../knowledge-base/wiki-folder-names";
import { EchoInkKnowledgeSurfaceService } from "../plugin/knowledge-surface-service";
import { localTodoDate, reconcileTodoCompletions, todoCompletionStatistics } from "../home/todo-completions";
import { TFolder, type App, type ReferenceCache } from "obsidian";
import { captureFolderLinkRenames, applyFolderLinkRenames } from "../knowledge-base/folder-link-renames";

export async function runWikiBilingualTests(): Promise<void> {
  assert.equal(wikiCategoryLabel(bilingualWikiFolderName("OpenAI", "开放人工智能")!), "开放人工智能 / OpenAI");
  for (const invalid of ["../逃逸", "命名/目录", "a\\b", "名称（重复）", "name", "X:"]) assert.equal(bilingualWikiFolderName("custom-topic", invalid), null);
  assert.equal(wikiFolderNeedsTranslation("wiki/custom-topic/sub-topic"), true);
  for (const dynamic of ["raw/foo", "archive/investment-journal-2025", "work/custom-project/research-notes", "finance/custom-reports"]) assert.equal(wikiFolderNeedsTranslation(dynamic), true);
  for (const hidden of ["wiki/.hidden/foo", "wiki/assets/images", "附件（assets）/screenshots", "raw/note.assets/images", "work/node_modules/library", "wiki/中文（AI）"]) assert.equal(wikiFolderNeedsTranslation(hidden), false);
  for (const text of ["先不要改", "只分析", "dry run", "do not write"]) assert.equal(maintenanceRequestsAdviceOnly(text), true);
  let dynamicFolders = ["work/custom-topic", "work/custom-topic/deep-category", "finance/custom-reports"];
  const dynamicInputs: string[] = [];
  const dynamicResult = await optimizeWikiFolderNames({
    folders: () => dynamicFolders.map((name) => ({ path: name, titles: ["note.md"] })),
    generate: async (_system, input) => {
      const folders = JSON.parse(input) as { id: string; path: string }[];
      dynamicInputs.push(...folders.map((folder) => folder.path));
      return JSON.stringify(Object.fromEntries(folders.map((folder) => [folder.id, "主题"])));
    },
    exists: (name) => dynamicFolders.includes(name), unsafeReason: () => null,
    rename: async (from, to) => { dynamicFolders = dynamicFolders.map((name) => name === from ? to : name.startsWith(`${from}/`) ? to + name.slice(from.length) : name); }
  });
  assert.equal(dynamicResult.renamed.length, 3);
  assert.ok(dynamicInputs.includes("finance/custom-reports"), "only fixed finance names bypass the model");
  assert.ok(dynamicFolders.includes("work/主题（custom-topic）/主题（deep-category）"));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "echoink-wiki-bilingual-"));
  try {
    const vault = path.join(root, "vault");
    await fs.mkdir(path.join(vault, "wiki/AI/sub-topic"), { recursive: true });
    await fs.mkdir(path.join(vault, "empty"));
    await fs.writeFile(path.join(vault, "wiki/AI/sub-topic/note.md"), "original");
    await fs.writeFile(path.join(vault, "attachment.bin"), Buffer.from([0, 1, 2, 255]));
    let crashAfterRename = false;
    const host = {
      vaultRoot: vault, privateRoot: path.join(root, "private"),
      mkdir: async (name: string) => { await fs.mkdir(path.join(vault, name), { recursive: true }); },
      rename: async (from: string, to: string) => { await fs.rename(path.join(vault, from), path.join(vault, to)); if (crashAfterRename) { crashAfterRename = false; throw new Error("interrupted after rename"); } },
      removeEmptyFolder: async (name: string) => { await fs.rmdir(path.join(vault, name)); }
    };
    const history = new InitializationDirectoryHistory(host);
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const locked = path.join(vault, "unreadable");
      await fs.mkdir(locked);
      await fs.writeFile(path.join(locked, "kept.md"), "keep in place");
      await fs.chmod(locked, 0);
      try {
        const warnings = await history.capture("first");
        assert.match(warnings.join("\n"), /记录原目录 unreadable：/u);
        assert.equal(await history.moveState("attachment.bin", "renamed.bin"), "ready", "one unreadable directory must not block independent tracked moves");
      } finally { await fs.chmod(locked, 0o700); }
    } else await history.capture("first");
    let folders = ["wiki/AI/sub-topic", "wiki/AI"];
    let modelCalls = 0;
    const renamed: string[] = [];
    const optimizeHost = {
      folders: () => folders.map((name) => ({ path: name, titles: ["note.md"] })),
      generate: async () => { modelCalls++; return '{"0":"子主题","1":"人工智能"}'; },
      exists: (name: string) => folders.includes(name), unsafeReason: () => null,
      rename: async (from: string, to: string) => {
        await history.rename(from, to); renamed.push(from);
        folders = folders.map((name) => name === from ? to : name.startsWith(`${from}/`) ? to + name.slice(from.length) : name);
      }
    };
    const result = await optimizeWikiFolderNames(optimizeHost);
    assert.equal(result.renamed.length, 2);
    assert.equal(renamed[0], "wiki/AI/sub-topic");
    await optimizeWikiFolderNames(optimizeHost);
    assert.equal(modelCalls, 1, "already bilingual performs no model call");
    const moved = "wiki/人工智能（AI）/子主题（sub-topic）/note.md";
    await fs.writeFile(path.join(vault, moved), "edited latest body");
    await fs.writeFile(path.join(vault, "wiki/人工智能（AI）/new.md"), "keep newer Wiki");
    await fs.rmdir(path.join(vault, "empty"));
    await fs.mkdir(path.join(vault, "archive"));
    await history.createdFolder("archive");
    await history.rename("attachment.bin", "archive/attachment.bin");
    await fs.writeFile(path.join(vault, "attachment.bin"), "conflict occupant");
    const restored = await new InitializationDirectoryHistory(host).restore();
    assert.equal(restored.restored, 1);
    assert.equal(restored.skipped.length, 1);
    assert.equal(await fs.readFile(path.join(vault, "wiki/AI/sub-topic/note.md"), "utf8"), "edited latest body");
    assert.equal(await fs.readFile(path.join(vault, "wiki/人工智能（AI）/new.md"), "utf8"), "keep newer Wiki");
    assert.ok((await fs.stat(path.join(vault, "empty"))).isDirectory());
    assert.equal(await fs.readFile(path.join(vault, "attachment.bin"), "utf8"), "conflict occupant");
    await fs.rm(path.join(vault, "attachment.bin"));
    assert.equal((await new InitializationDirectoryHistory(host).restore()).restored, 1);
    assert.deepEqual(await fs.readFile(path.join(vault, "attachment.bin")), Buffer.from([0, 1, 2, 255]));
    assert.equal((await history.restore()).restored, 0);
    assert.equal(await fs.stat(path.join(vault, "archive")).catch(() => null), null);
    crashAfterRename = true;
    await assert.rejects(history.rename("attachment.bin", "renamed.bin"), /interrupted/u);
    assert.equal((await new InitializationDirectoryHistory(host).restore()).restored, 1, "restart resolves a move persisted before its completion");
    await fs.writeFile(path.join(root, "not-a-directory"), "blocked");
    await assert.rejects(new InitializationDirectoryHistory({ ...host, privateRoot: path.join(root, "not-a-directory") }).capture("failure"));
    assert.ok(await fs.stat(path.join(vault, "attachment.bin")));
    let cancelled = false;
    let movesAfterCancel = 0;
    await assert.rejects(optimizeWikiFolderNames({ ...optimizeHost,
      folders: () => [{ path: "wiki/test", titles: [] }], exists: () => true,
      generate: async () => { cancelled = true; return '{"0":"测试"}'; },
      assertActive: () => { if (cancelled) throw new Error("cancelled"); },
      rename: async () => { movesAfterCancel++; }
    }), /cancelled/u);
    assert.equal(movesAfterCancel, 0);
    const collision = await optimizeWikiFolderNames({ ...optimizeHost, folders: () => [{ path: "wiki/test", titles: [] }], exists: () => true, generate: async () => '{"0":"测试"}' });
    assert.equal(collision.renamed.length, 0);
    assert.match(collision.skipped[0].reason, /目标已存在/u);
  } finally { await fs.rm(root, { recursive: true, force: true }); }

  const prototype = Object.create(EchoInkKnowledgeSurfaceService.prototype) as EchoInkKnowledgeSurfaceService;
  const service = prototype as unknown as { plugin: unknown; structureQueue: Promise<unknown>; renameUnsafeReason(path: string): string | null };
  service.structureQueue = Promise.resolve();
  const links: Record<string, Record<string, number>> = { "wiki/AI/note.md": { "raw/source.md": 1 } };
  service.plugin = { settings: { defaultPermission: "read-only" }, app: {
    vault: { getFiles: () => [{ path: "wiki/AI/note.md", basename: "note" }], getConfig: () => false },
    metadataCache: { resolvedLinks: links, unresolvedLinks: {}, getFileCache: () => ({ links: [{ link: "raw/source" }] }) }
  } };
  assert.equal(service.renameUnsafeReason("wiki/AI"), null, "absolute Raw outgoing links need no rewrites");
  links["raw/source.md"] = { "wiki/AI/note.md": 1 };
  assert.match(service.renameUnsafeReason("wiki/AI")!, /Obsidian/u);
  const unrelatedService = Object.create(EchoInkKnowledgeSurfaceService.prototype) as typeof service;
  unrelatedService.plugin = { app: {
    vault: { getFiles: () => [{ path: "testing/note.md", basename: "note" }], getConfig: () => true },
    metadataCache: { resolvedLinks: {}, unresolvedLinks: { "other.md": { "webapp-testing": 1, "git-worktrees": 1, note: 1, "wiki/other/journal": 1 } }, getFileCache: () => ({}) }
  } };
  for (const folder of ["testing", "work", "journal"]) assert.equal(unrelatedService.renameUnsafeReason(folder), null);
  await assert.rejects(prototype.withStructureMutation(async () => 1), /只读/u);
  assert.equal(await prototype.withStructureMutation(async () => 2, true), 2, "turn write permission overrides the default");

  const replacementRoot = await fs.mkdtemp(path.join(os.tmpdir(), "echoink-directory-replacement-"));
  try {
    const vaultRoot = path.join(replacementRoot, "vault");
    await fs.mkdir(path.join(vaultRoot, "wiki/test"), { recursive: true });
    await fs.writeFile(path.join(vaultRoot, "wiki/test/original.md"), "original");
    const history = new InitializationDirectoryHistory({ vaultRoot, privateRoot: path.join(replacementRoot, "private"),
      mkdir: async (name) => { await fs.mkdir(path.join(vaultRoot, name), { recursive: true }); },
      rename: async (from, to) => { await fs.rename(path.join(vaultRoot, from), path.join(vaultRoot, to)); },
      removeEmptyFolder: async (name) => { await fs.rmdir(path.join(vaultRoot, name)); }
    });
    await history.capture("replacement");
    await fs.writeFile(path.join(vaultRoot, "replacement.md"), "later user file");
    await fs.rename(path.join(vaultRoot, "replacement.md"), path.join(vaultRoot, "wiki/test/original.md"));
    await history.rename("wiki/test", "wiki/测试（test）");
    const restored = await history.restore();
    assert.equal(restored.restored, 0);
    assert.match(restored.skipped[0].reason, /身份/u);
    assert.equal(await fs.readFile(path.join(vaultRoot, "wiki/测试（test）/original.md"), "utf8"), "later user file");

    const linksRoot = path.join(replacementRoot, "links");
    await fs.mkdir(linksRoot);
    await fs.writeFile(path.join(linksRoot, "A.md"), "[[B]]");
    await fs.writeFile(path.join(linksRoot, "B.md"), "[[A]]");
    const files = new Map(["A.md", "B.md"].map((name) => [name, { path: name, basename: name.slice(0, -3) }]));
    const renameService = Object.create(EchoInkKnowledgeSurfaceService.prototype) as unknown as { plugin: unknown; renameWithLinks(from: string, to: string, restoring?: boolean): Promise<void> };
    (renameService as unknown as { syncRenamedPaths(): Promise<void> }).syncRenamedPaths = async () => {};
    renameService.plugin = { app: { vault: { getFiles: () => [...files.values()], getMarkdownFiles: () => [], getAbstractFileByPath: (name: string) => files.get(name) ?? null, getConfig: () => true },
      metadataCache: { resolvedLinks: { "raw/imported/A.md": { "B.md": 1 } }, unresolvedLinks: {}, getFileCache: () => ({ links: [] }) },
      fileManager: { renameFile: async (file: {path: string}, to: string) => { const from = file.path; await fs.rename(path.join(linksRoot, from), path.join(linksRoot, to)); files.delete(from); file.path = to; files.set(to, file as {path:string;basename:string}); } }
    } };
    const linkHistory = new InitializationDirectoryHistory({ vaultRoot: linksRoot, privateRoot: path.join(replacementRoot, "link-private"),
      mkdir: async (name) => { await fs.mkdir(path.join(linksRoot, name), { recursive: true }); },
      rename: (from, to, restoring) => renameService.renameWithLinks(from, to, restoring),
      removeEmptyFolder: async (name) => { await fs.rmdir(path.join(linksRoot, name)); }
    });
    await linkHistory.capture("links");
    await fs.mkdir(path.join(linksRoot,"raw/imported"), {recursive:true});
    await linkHistory.rename("A.md", "raw/imported/A.md");
    await linkHistory.rename("B.md", "raw/imported/B.md");
    assert.equal((await linkHistory.restore()).restored, 2, "initialization and restoration must permit linked note moves");
    assert.equal(await fs.readFile(path.join(linksRoot,"A.md"),"utf8"), "[[B]]");
    assert.equal(await fs.readFile(path.join(linksRoot,"B.md"),"utf8"), "[[A]]");
  } finally { await fs.rm(replacementRoot, { recursive:true, force:true }); }
  for (const [platform, rootPath, flavor] of [["macOS", "/Users/test/vault", path.posix], ["Linux", "/home/test/vault", path.posix], ["Windows", "C:\\Users\\test\\vault", path.win32]] as const) {
    const segments = ["wiki", bilingualWikiFolderName("AI", "人工智能")!, "note.md"];
    const joined = flavor.join(rootPath, ...segments);
    assert.equal(flavor.relative(rootPath, joined).split(flavor.sep).join("/"), segments.join("/"), `${platform} portable path semantics`);
  }
  runTodoCalendarStatisticsTests();
  await runFolderLinkRenameTests();
  await runDirectoryFolderRestoreTests();
  console.log("Wiki naming, directory restore, permissions, cancellation and daily counting: PASS");
}

async function runFolderLinkRenameTests(): Promise<void> {
  const folder = (name: string) => Object.assign(new TFolder(), { path: name });
  const entries = new Map<string, { path: string }>([
    ["archive", folder("archive")], ["archive/investment", folder("archive/investment")],
    ["archive/investment/child", folder("archive/investment/child")], ["outside", folder("outside")],
    ["index.md", { path: "index.md" }], ["archive/readme.md", { path: "archive/readme.md" }],
    ["archive/investment/note.md", { path: "archive/investment/note.md" }]
  ]);
  for (const name of ["review-browser.html", "reviews.csv", "reviews.jsonl"]) entries.set(`archive/investment/${name}`, { path: `archive/investment/${name}` });
  const bodies = new Map([
    ["index.md", [
      "[[archive/investment|投资]]", "[[archive/investment/child#标题|子分类]]", "[folder](archive/investment/)",
      "[[archive/investment/note]]", "[[archive/investment/missing]]", "[[investment-journal-2025]]",
      "[html](/Users/fixture/Vault/archive/investment/review-browser.html#section)",
      "[csv](file:///Users/fixture/Vault/archive/investment/reviews.csv)",
      "[json](/Users/fixture/Vault/archive/investment/reviews.jsonl)",
      "[outside-vault](/Users/fixture/Vault-other/archive/investment/reviews.csv)",
      "[missing-absolute](/Users/fixture/Vault/archive/investment/missing.csv)",
      "[external-file](file:///Users/fixture/Other/archive/investment/reviews.csv)",
      "[external](https://example.com/archive/investment)", "`[[archive/investment]]`", "```", "[[archive/investment]]", "```"
    ].join("\n")],
    ["archive/readme.md", "[folder](./investment/ \"标题\")\n![[investment/child|目录]]\n[[archive/investment]]"],
    ["archive/investment/note.md", "[outside](../../outside/)\n[[archive/investment/child]]"]
  ]);
  const scan = (content: string): ReferenceCache[] => {
    const refs: ReferenceCache[] = [];
    let offset = 0, fenced = false;
    for (const line of content.split("\n")) {
      if (line === "```") fenced = !fenced;
      if (!fenced && !line.startsWith("`")) for (const match of line.matchAll(/!?\[\[[^\]]+\]\]|!?\[[^\]]*\]\([^\n]+?\)/gu)) {
        const original = match[0];
        const link = original.startsWith("[[") || original.startsWith("![[") ? original.replace(/^!?\[\[|\]\]$/gu, "").split("|")[0] : original.slice(original.indexOf("](") + 2, -1);
        refs.push({ link, original, position: { start: { line: 0, col: 0, offset: offset + match.index }, end: { line: 0, col: 0, offset: offset + match.index + original.length } } });
      }
      offset += line.length + 1;
    }
    return refs;
  };
  let staleReads = 0;
  const oldIndexRefs = scan(bodies.get("index.md")!);
  const app = { vault: {
    adapter: { getBasePath: () => "/Users/fixture/Vault" },
    getAbstractFileByPath: (name: string) => entries.get(name) ?? null,
    getFileByPath: (name: string) => entries.get(name) ?? null,
    getMarkdownFiles: () => [...entries.values()].filter((file) => file.path.endsWith(".md")),
    read: async (file: { path: string }) => bodies.get(file.path)!,
    process: async (file: { path: string }, change: (text: string) => string) => { bodies.set(file.path, change(bodies.get(file.path)!)); }
  }, metadataCache: {
    getFirstLinkpathDest: (name: string) => name === "archive/investment/note" ? entries.get("archive/investment/note.md") : null,
    getFileCache: (file: { path: string }) => ({ links: staleReads > 0 && file.path === "index.md" ? (staleReads--, oldIndexRefs) : scan(bodies.get(file.path)!) })
  } } as unknown as App;
  const plans = await captureFolderLinkRenames(app, "archive/investment", "archive/投资（investment）");
  assert.equal(plans.length, 3);
  for (const [name, file] of [...entries]) if (name === "archive/investment" || name.startsWith("archive/investment/")) {
    const next = name.replace("archive/investment", "archive/投资（investment）");
    entries.delete(name); entries.set(next, Object.assign(file, { path: next }));
    if (bodies.has(name)) { bodies.set(next, bodies.get(name)!); bodies.delete(name); }
  }
  // The native API updates a file link first; the new text shifts directory-link offsets.
  bodies.set("index.md", `Native update\n${bodies.get("index.md")!.replace("[[archive/investment/note]]", "[[archive/投资（investment）/note]]")}`);
  staleReads = 2;
  await applyFolderLinkRenames(app, plans);
  const index = bodies.get("index.md")!;
  assert.ok(index.includes("[[archive/投资（investment）|投资]]"));
  assert.ok(index.includes("[[archive/投资（investment）/child#标题|子分类]]"));
  assert.ok(index.includes(`[folder](${encodeURI("archive/投资（investment）/")})`));
  assert.ok(index.includes(`[html](${encodeURI("/Users/fixture/Vault/archive/投资（investment）/review-browser.html")}#section)`));
  assert.ok(index.includes(`[csv](file://${encodeURI("/Users/fixture/Vault/archive/投资（investment）/reviews.csv")})`));
  assert.ok(index.includes(`[json](${encodeURI("/Users/fixture/Vault/archive/投资（investment）/reviews.jsonl")})`));
  for (const unchanged of ["[[archive/investment/missing]]", "[[investment-journal-2025]]", "https://example.com/archive/investment", "`[[archive/investment]]`", "```\n[[archive/investment]]\n```", "/Users/fixture/Vault-other/archive/investment/reviews.csv", "/Users/fixture/Vault/archive/investment/missing.csv", "file:///Users/fixture/Other/archive/investment/reviews.csv"]) assert.ok(index.includes(unchanged), unchanged);
  assert.ok(bodies.get("archive/readme.md")!.includes(`[folder](./${encodeURI("投资（investment）/")} \"标题\")`));
  assert.ok(bodies.get("archive/readme.md")!.includes("![[投资（investment）/child|目录]]"));
  assert.ok(bodies.get("archive/投资（investment）/note.md")!.includes("[outside](../../outside/)"));

  // Parent moves keep the already-translated child, and relative links inside it remain valid.
  const parentPlans = await captureFolderLinkRenames(app, "archive", "归档（archive）");
  assert.ok(parentPlans.length >= 2);
  for (const [name, file] of [...entries]) if (name === "archive" || name.startsWith("archive/")) {
    const next = name.replace("archive", "归档（archive）");
    entries.delete(name); entries.set(next, Object.assign(file, { path: next }));
    if (bodies.has(name)) { bodies.set(next, bodies.get(name)!); bodies.delete(name); }
  }
  await applyFolderLinkRenames(app, parentPlans);
  assert.ok(bodies.get("index.md")!.includes("[[归档（archive）/投资（investment）|投资]]"));
  const oldCsv = "归档（archive）/投资（investment）/reviews.csv", restoredCsv = "archive/investment/reviews.csv";
  const filePlans = await captureFolderLinkRenames(app, oldCsv, restoredCsv);
  entries.delete(oldCsv); entries.set(restoredCsv, { path: restoredCsv });
  await applyFolderLinkRenames(app, filePlans);
  assert.ok(bodies.get("index.md")!.includes("[csv](file:///Users/fixture/Vault/archive/investment/reviews.csv)"), "single-file restoration also updates absolute file URLs");

  const conflictPlans = await captureFolderLinkRenames(app, "归档（archive）", "已归档（archive）");
  // Simulate a changed source while the original metadata has no matching references.
  const plan = conflictPlans.find((item) => item.path === "index.md")!;
  bodies.set("index.md", "User replaced the note\n");
  await assert.rejects(applyFolderLinkRenames(app, [plan]), /同步未完成/u);
  assert.equal(bodies.get("index.md"), "User replaced the note\n");
}

async function runDirectoryFolderRestoreTests(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "echoink-folder-link-restore-"));
  const vault = path.join(root, "vault"), privateRoot = path.join(root, "private");
  const indexPath = path.join(privateRoot, "knowledge/initialization/original-directory-index.json");
  const synced: Array<[string, string]> = [];
  let interrupted = false;
  try {
    await fs.mkdir(path.join(vault, "archive/child/empty"), { recursive: true });
    await fs.mkdir(path.join(vault, "archive/empty"));
    await fs.writeFile(path.join(vault, "archive/child/note.md"), "original");
    const host = { vaultRoot: vault, privateRoot,
      mkdir: async (folder: string) => { await fs.mkdir(path.join(vault, folder), { recursive: true }); },
      rename: async (from: string, to: string) => { await fs.rename(path.join(vault, from), path.join(vault, to)); if (interrupted) { interrupted = false; throw new Error("interrupted folder rename"); } },
      restoreFolderLinks: async (from: string, to: string) => { assert.ok((await fs.stat(path.join(vault, from))).isDirectory()); assert.ok((await fs.stat(path.join(vault, to))).isDirectory()); synced.push([from, to]); },
      removeEmptyFolder: async (folder: string) => { await fs.rmdir(path.join(vault, folder)); }
    };
    const history = new InitializationDirectoryHistory(host);
    await history.capture("legacy-index");
    const legacy = JSON.parse(await fs.readFile(indexPath, "utf8"));
    assert.equal(legacy.folderRenames, undefined, "old indexes need no schema migration");
    await history.rename("archive/child", "archive/子（child）");
    interrupted = true;
    await assert.rejects(history.rename("archive", "归档（archive）"), /interrupted/u);
    const pending = JSON.parse(await fs.readFile(indexPath, "utf8"));
    assert.equal(pending.pending.folderOriginal, "archive");
    const restored = await new InitializationDirectoryHistory(host).restore();
    assert.equal(restored.restored, 1);
    assert.equal(restored.skipped.length, 0);
    for (const expected of [["归档（archive）/子（child）/empty", "archive/child/empty"], ["归档（archive）/子（child）", "archive/child"], ["归档（archive）/empty", "archive/empty"], ["归档（archive）", "archive"]]) assert.ok(synced.some((pair) => pair[0] === expected[0] && pair[1] === expected[1]), expected.join(" -> "));
    assert.equal(await fs.stat(path.join(vault, "归档（archive）")).catch(() => null), null);
    assert.equal(await fs.readFile(path.join(vault, "archive/child/note.md"), "utf8"), "original");

    // A second optimization after restoration must refresh, rather than reuse stale positions.
    synced.length = 0;
    await history.rename("archive", "档案（archive）");
    await fs.writeFile(path.join(vault, "档案（archive）/new.md"), "new user file");
    await fs.mkdir(path.join(vault, "archive/child"), { recursive: true });
    await fs.writeFile(path.join(vault, "archive/child/note.md"), "conflicting occupant");
    const partial = await history.restore();
    assert.equal(partial.restored, 0);
    assert.equal(partial.skipped.length, 1);
    assert.ok(!synced.some(([from]) => from === "档案（archive）" || from === "档案（archive）/child"), "live directories containing new/conflicting files retain their current links");
    assert.equal(await fs.readFile(path.join(vault, "档案（archive）/new.md"), "utf8"), "new user file");
    await fs.rm(path.join(vault, "archive/child/note.md"));
    const finished = await history.restore();
    assert.equal(finished.restored, 1);
    assert.ok(synced.some(([from, to]) => from === "档案（archive）/child" && to === "archive/child"));
    assert.ok(!synced.some(([from]) => from === "档案（archive）"), "new content keeps the parent and its folder link in place");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

export function runTodoCalendarStatisticsTests(): void {
  const one = new Date(2026, 8, 17, 23, 59);
  const two = new Date(2026, 8, 18, 0, 1);
  assert.equal(localTodoDate(two), "2026-09-18");
  let history = reconcileTodoCompletions({}, [{ id: "old", done: true }], [], false, one);
  history = reconcileTodoCompletions(history, [{ id: "a", done: true }, { id: "b", done: true }], [{ id: "a", done: false }, { id: "b", done: false }], true, one);
  assert.equal(todoCompletionStatistics(history, one).today, 2);
  history = reconcileTodoCompletions(history, [{ id: "a", done: false }], [{ id: "a", done: true }], true, two);
  history = reconcileTodoCompletions(history, [{ id: "a", done: true }], [{ id: "a", done: false }], true, two);
  const stats = todoCompletionStatistics(history, two);
  assert.equal(stats.total, 3); assert.equal(stats.today, 1); assert.equal(stats.unknown, 1);
  assert.deepEqual(stats.activity, [{ date: "2026-09-17", count: 1 }, { date: "2026-09-18", count: 1 }], "re-completion moves only that task to its new date");
  const annualHistory = { unknown: null, leap: "2024-02-29", leapSecond: "2024-02-29", previous: "2025-12-31", previousSecond: "2025-12-31", today: "2026-01-01" };
  const newYear = new Date(2026, 0, 1, 0, 1);
  const allTime = todoCompletionStatistics(annualHistory, newYear);
  assert.deepEqual(allTime.activity, [
    { date: "2024-02-29", count: 2 }, { date: "2025-12-31", count: 2 }, { date: "2026-01-01", count: 1 }
  ], "one sparse entry per recorded date preserves cross-year and leap-day counts");
  assert.equal(allTime.total, 6);
  assert.equal(allTime.today, 1);
  assert.equal(allTime.unknown, 1);
  assert.equal(allTime.activity.reduce((sum, day) => sum + day.count, 0), allTime.total - allTime.unknown, "each dated task is counted once and undated tasks stay outside the heatmap");
  const previousDay = todoCompletionStatistics(annualHistory, new Date(2025, 11, 31, 23, 59));
  assert.equal(previousDay.today, 2);
  assert.deepEqual(previousDay.activity, allTime.activity, "changing today does not clip historical activity");
  assert.deepEqual(todoCompletionStatistics({}, newYear), { total: 0, today: 0, unknown: 0, activity: [] });
  assert.deepEqual(todoCompletionStatistics({ unknown: null }, newYear), { total: 1, today: 0, unknown: 1, activity: [] });
}
