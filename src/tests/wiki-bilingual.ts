import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { InitializationDirectoryHistory } from "../knowledge-base/initialization-directory-history";
import { bilingualWikiFolderName, wikiCategoryLabel, wikiFolderNeedsTranslation, optimizeWikiFolderNames, maintenanceRequestsAdviceOnly } from "../knowledge-base/wiki-folder-names";
import { EchoInkKnowledgeSurfaceService } from "../plugin/knowledge-surface-service";
import { localTodoDate, reconcileTodoCompletions, todoCompletionStatistics } from "../home/todo-completions";

export async function runWikiBilingualTests(): Promise<void> {
  assert.equal(wikiCategoryLabel(bilingualWikiFolderName("OpenAI", "开放人工智能")!), "开放人工智能 / OpenAI");
  for (const invalid of ["../逃逸", "命名/目录", "a\\b", "名称（重复）", "name", "X:"]) assert.equal(bilingualWikiFolderName("custom-topic", invalid), null);
  assert.equal(wikiFolderNeedsTranslation("wiki/custom-topic/sub-topic"), true);
  for (const hidden of ["raw/foo", "wiki/.hidden/foo", "wiki/assets/images", "wiki/中文（AI）"]) assert.equal(wikiFolderNeedsTranslation(hidden), false);
  for (const text of ["先不要改", "只分析", "dry run", "do not write"]) assert.equal(maintenanceRequestsAdviceOnly(text), true);
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
    await history.capture("first");
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
  assert.match(service.renameUnsafeReason("wiki/AI")!, /Raw/u);
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
    renameService.plugin = { app: { vault: { getFiles: () => [...files.values()], getAbstractFileByPath: (name: string) => files.get(name) ?? null, getConfig: () => true },
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
  assert.equal(stats.days.find((day) => day.date === "2026-09-17")?.count, 1);
  assert.equal(stats.days.length, 365);
  assert.equal(new Set(stats.days.map((day) => day.date)).size, 365);
  console.log("Wiki naming, directory restore, permissions, cancellation and daily counting: PASS");
}
