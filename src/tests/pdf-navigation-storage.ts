import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { TFile, TFolder, type App } from "obsidian";
import { PdfReadingService, type PdfDependencies } from "../pdf-reading/service";
import { PdfReadingController } from "../pdf-reading/controller";
import { PdfVaultFiles } from "../pdf-reading/vault-files";
import type { PdfFiles, PdfJob, PdfOptions, PdfStartContext, PdfNavigationArtifact } from "../pdf-reading/types";
import { emptyKnowledgeFolderBindings, registerKnowledgeFolderBindings } from "../knowledge-base/root-paths";

const pdf = new TextEncoder().encode("%PDF- synthetic original bytes");
const base: PdfOptions = { engine: "local", reading: false, translation: false, wiki: false };
const statePath = (id: string) => `state/${id}.json`;
type Hook = (event: string, target: string, value?: string | Uint8Array) => void | Promise<void>;
class MemoryFiles implements PdfFiles {
  data = new Map<string, string | Uint8Array>();
  directories = new Set(["raw", "raw/originals", "raw/other", "wiki"]);
  events: string[] = [];
  hook?: Hook;
  async exists(target: string) { return this.data.has(target) || this.directories.has(target); }
  async read(target: string) { const value = this.data.get(target); if (typeof value !== "string") throw new Error("missing text"); return value; }
  async readBinary(target: string) { const value = this.data.get(target); if (!(value instanceof Uint8Array)) throw new Error("missing binary"); return new Uint8Array(value); }
  async create(target: string, value: string | Uint8Array) {
    await this.hook?.("before-create", target, value); assert.equal(this.data.has(target), false, "create never overwrites");
    this.data.set(target, typeof value === "string" ? value : new Uint8Array(value)); this.events.push(`create:${target}`);
    await this.hook?.("after-create", target, value);
  }
  async replace(target: string, value: string, expected?: string) {
    await this.hook?.("before-replace", target, value);
    if (expected !== undefined) assert.equal(this.data.get(target), expected);
    this.data.set(target, value); this.events.push(`replace:${target}`); await this.hook?.("after-replace", target, value);
  }
  async listJobs() { return [...this.data.keys()].filter(target => /^state\/[a-z0-9-]+\.json$/u.test(target)).map(target => target.slice(6, -5)); }
  roots() { return ["raw", "wiki"]; }
}
function fixture(files = new MemoryFiles(), originals = true) {
  let paid = true, enabled = true, allowedDirectory = true, originalDirectory = "raw/originals", parses = 0, remote = 0, generations = 0;
  const access = { checkCapability: () => paid, requireCapability: () => { if (!paid) throw new Error("expired fixture PRO"); }, subscribe: () => () => {} };
  const deps: PdfDependencies = {
    access, enabled: () => enabled, sourceDirectory: () => "raw", canWriteKnowledge: () => true,
    ...(originals ? { originalDirectory: () => originalDirectory, validateOriginalDirectory: (directory: string) => {
      if (!allowedDirectory || !files.directories.has(directory) || !directory.startsWith("raw/")) throw new Error("保存位置已失效");
    } } : {}),
    local: async () => { parses++; files.events.push("local"); return { pages: [{ number: 1, markdown: "A source paragraph about useful evidence." }], images: [], warnings: [], engine: "local" }; },
    enhanced: async () => { remote++; files.events.push("remote"); return { pages: [{ number: 1, markdown: "Remote source." }], images: [], warnings: [], engine: "mineru" }; },
    generator: () => ({ maxSourceCharacters: 1000, generate: async () => { generations++; return "A generated analysis or translation."; } })
  };
  return { files, deps, service: new PdfReadingService(files, "state", deps), counts: () => ({ parses, remote, generations }),
    change: (value: { paid?: boolean; enabled?: boolean; directory?: string; allowedDirectory?: boolean }) => {
      if (value.paid !== undefined) paid = value.paid; if (value.enabled !== undefined) enabled = value.enabled;
      if (value.directory !== undefined) originalDirectory = value.directory; if (value.allowedDirectory !== undefined) allowedDirectory = value.allowedDirectory;
    } };
}
async function readonly<T>(files: MemoryFiles, action: () => Promise<T>): Promise<T> {
  const before = structuredClone([...files.data]), events = files.events.length;
  const result = await action(); assert.equal(files.events.length, events); assert.deepEqual([...files.data], before); return result;
}
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100 && !predicate(); index++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(predicate(), "the real processing await was reached");
}

async function serviceBoundaries(): Promise<void> {
  // Pure preparation freezes the bytes/choices/target without creating a job or processing anything.
  {
    const f = fixture();
    const intent = await readonly(f.files, () => f.service.prepareStartIntent("Study.pdf", pdf, { ...base, summary: true, wiki: true }, "prepare-only", { conversationId: "task-a" }));
    assert.equal(intent.original!.plannedPath, "raw/originals/Study-prepare-only.pdf"); assert.equal(intent.conversationId, "task-a");
    assert.equal(intent.options.reading, false); assert.equal(intent.options.summary, true); assert.ok(Object.isFrozen(intent.options));
    assert.deepEqual(f.counts(), { parses: 0, remote: 0, generations: 0 });
    await assert.rejects(() => f.service.start("Study.pdf", new TextEncoder().encode("%PDF- changed bytes"), intent.options, undefined, intent.id, undefined, { intent }), /已变化/u);
    await assert.rejects(() => f.service.start("Study.pdf", pdf, { ...intent.options, reading: true }, undefined, intent.id, undefined, { intent }), /已变化/u);
    assert.equal(f.files.data.size, 0);
  }
  // The desktop policy also covers the old start signature, before parser/model execution.
  {
    const f = fixture();
    f.files.hook = (event, target) => {
      if (event === "before-create" && target.endsWith(".pdf")) {
        const stored = JSON.parse(f.files.data.get(statePath("ordered")) as string) as PdfJob;
        assert.equal(stored.original!.plannedPath, target); assert.equal(stored.original!.savedPath, undefined);
      }
    };
    const oldLocal = f.deps.local;
    f.deps.local = async (...args) => {
      const stored = JSON.parse(f.files.data.get(statePath("ordered")) as string) as PdfJob;
      assert.equal(stored.original!.savedPath, stored.original!.plannedPath);
      assert.deepEqual(await f.files.readBinary(stored.original!.savedPath!), pdf);
      return oldLocal(...args);
    };
    const job = await f.service.start("Study.pdf", pdf, base, undefined, "ordered");
    assert.equal(job.state, "completed"); assert.ok(job.original!.savedPath); assert.deepEqual(pdf, new TextEncoder().encode("%PDF- synthetic original bytes"));
    assert(f.files.events.indexOf(`create:${statePath(job.id)}`) < f.files.events.indexOf(`create:${job.original!.savedPath}`));
    assert(f.files.events.indexOf(`create:${job.original!.savedPath}`) < f.files.events.indexOf("local"));
    const originalCreates = f.files.events.filter(event => event.endsWith(".pdf")).length;
    await f.service.start("Study.pdf", pdf, base, undefined, job.id);
    await f.service.resume(job.id);
    assert.equal(f.files.events.filter(event => event.endsWith(".pdf")).length, originalCreates); assert.equal(f.counts().parses, 1);
    const raw = await f.files.read(job.artifacts.find(item => item.kind === "raw")!.path); assert.ok(raw.includes(job.original!.savedPath!));
    await assert.rejects(() => f.service.start("Study.pdf", new TextEncoder().encode("%PDF- different source"), base, undefined, job.id), /范围|变化/u);
  }
  // A crash after binary create but before its marker reuses the exact planned bytes on reopen.
  {
    const f = fixture(); let fail = true;
    f.files.hook = (event, target) => { if (fail && event === "after-create" && target.endsWith(".pdf")) { fail = false; throw new Error("crash after original create"); } };
    const interrupted = await f.service.start("Crash.pdf", pdf, base, undefined, "crash-window");
    assert.equal(interrupted.state, "failed"); assert.equal(interrupted.original!.savedPath, undefined); assert.equal(f.counts().parses, 0);
    const path = interrupted.original!.plannedPath; assert.ok(f.files.data.has(path));
    const restarted = new PdfReadingService(f.files, "state", f.deps);
    const recovered = await restarted.resume(interrupted.id);
    assert.equal(recovered.state, "completed"); assert.equal(recovered.original!.savedPath, path);
    assert.equal(f.files.events.filter(event => event === `create:${path}`).length, 1); assert.equal(f.counts().parses, 1);
  }
  // Failed writes/readback stop remote upload and models; parse failure retains the saved source.
  {
    const intentReadback = fixture();
    intentReadback.files.hook = (event, target) => { if (event === "after-create" && target === statePath("unverified-intent")) intentReadback.files.data.set(target, "unverified intent bytes"); };
    const unverified = await intentReadback.service.start("Intent.pdf", pdf, base, undefined, "unverified-intent");
    assert.equal(unverified.state, "failed"); assert.match(unverified.error!, /任务记录保存后/u); assert.equal(intentReadback.counts().parses, 0);
    assert.equal([...intentReadback.files.data.keys()].some(target => target.endsWith(".pdf")), false);
    const f = fixture();
    f.files.hook = (event, target) => { if (event === "before-create" && target.endsWith(".pdf")) throw new Error("binary disk failure"); };
    const failed = await f.service.start("Remote.pdf", pdf, { ...base, engine: "mineru", translation: true }, undefined, "write-failed");
    assert.equal(failed.state, "failed"); assert.deepEqual(f.counts(), { parses: 0, remote: 0, generations: 0 });
    assert.equal(f.files.data.has(failed.original!.plannedPath), false);
    f.files.hook = undefined;
    const local = f.deps.local; f.deps.local = async () => { throw new Error("parse failed"); };
    const parsed = await f.service.start("Keep.pdf", pdf, base, undefined, "parse-failed");
    assert.equal(parsed.state, "failed"); assert.deepEqual(await f.files.readBinary(parsed.original!.savedPath!), pdf);
    f.deps.local = local; assert.equal((await f.service.resume(parsed.id)).state, "completed");
    const bad = fixture();
    bad.files.hook = (event, target, value) => { if (event === "after-create" && value instanceof Uint8Array) { const wrong = new Uint8Array(value); wrong[wrong.length - 1] ^= 1; bad.files.data.set(target, wrong); } };
    const mismatch = await bad.service.start("Bad.pdf", pdf, base, undefined, "bad-readback");
    assert.equal(mismatch.state, "failed"); assert.match(mismatch.error!, /改过/u); assert.equal(bad.counts().parses, 0);
    assert.equal(mismatch.original!.savedPath, undefined); assert.equal([...bad.files.data.keys()].filter(target => target.endsWith(".pdf")).length, 1);
  }
  // Changes while parsing or generating are detected after the actual awaited operation returns.
  {
    const f = fixture(); let finish: (() => void) | undefined;
    f.deps.local = async () => { await new Promise<void>(resolve => { finish = resolve; }); return { pages: [{ number: 1, markdown: "Extracted before edit." }], images: [], warnings: [], engine: "local" }; };
    const flight = f.service.start("Parse-race.pdf", pdf, { ...base, translation: true }, undefined, "parse-race");
    await waitFor(() => !!finish);
    const original = f.service.current!.original!.savedPath!;
    f.files.data.set(original, new TextEncoder().encode("%PDF- modified during parse")); finish!();
    const stopped = await flight;
    assert.match(stopped.error!, /改过/u); assert.equal(stopped.artifacts.length, 0); assert.equal(f.counts().generations, 0);
    for (const target of ["original", "raw"] as const) {
      const g = fixture(); let complete: ((text: string) => void) | undefined;
      g.deps.generator = () => ({ maxSourceCharacters: 1000, generate: async () => new Promise<string>(resolve => { complete = resolve; }) });
      const generating = g.service.start("Model-race.pdf", pdf, { ...base, translation: true }, undefined, `model-race-${target}`);
      await waitFor(() => !!complete);
      const job = g.service.current!;
      if (target === "original") g.files.data.delete(job.original!.savedPath!);
      else {
        const raw = job.artifacts.find(item => item.kind === "raw")!.path;
        g.files.data.set(raw, `${await g.files.read(raw)}\nA user edit while generation is pending.`);
      }
      complete!("A generated result that must not be published against changed sources.");
      const result = await generating;
      assert.equal(result.state, "partial"); assert.equal(result.artifacts.some(item => item.kind === "translation"), false);
      assert.equal(result.chunks[0].translation, undefined);
      assert.match(result.error!, target === "original" ? /找不到/u : /正文已编辑/u);
    }
  }
  // Same-name unrelated files, changed originals and missing originals never get overwritten/recreated.
  {
    const f = fixture(); const intent = await f.service.prepareStartIntent("Same.pdf", pdf, base, "conflict");
    const unrelated = new TextEncoder().encode("%PDF- unrelated existing file"); f.files.data.set(intent.original!.plannedPath, unrelated);
    const conflict = await f.service.start("Same.pdf", pdf, base, undefined, intent.id, undefined, { intent });
    assert.equal(conflict.state, "failed"); assert.deepEqual(await f.files.readBinary(intent.original!.plannedPath), unrelated); assert.equal(f.counts().parses, 0);
    const saved = await f.service.start("Same.pdf", pdf, base, undefined, "different-job");
    assert.notEqual(saved.original!.plannedPath, intent.original!.plannedPath);
    f.files.data.set(saved.original!.savedPath!, unrelated);
    const changed = await f.service.resume(saved.id); assert.match(changed.error!, /改过/u); assert.equal(f.counts().parses, 1);
    f.files.data.delete(saved.original!.savedPath!);
    const missing = await f.service.resume(saved.id, undefined, pdf); assert.match(missing.error!, /找不到/u);
    assert.equal(f.files.data.has(saved.original!.savedPath!), false);
  }
  // Confirmation freezes the directory; capability/cancellation rechecks stop later side effects.
  {
    const f = fixture(); const intent = await f.service.prepareStartIntent("Frozen.pdf", pdf, base, "frozen");
    f.change({ directory: "raw/other" });
    const job = await f.service.start("Frozen.pdf", pdf, base, undefined, intent.id, undefined, { intent });
    assert.equal(job.original!.savedPath, intent.original!.plannedPath);
    await assert.rejects(() => f.service.start("Frozen.pdf", pdf, base, undefined, "new-id", undefined, { intent }), /变化/u);
    const denied = fixture(); let allowed = true;
    denied.files.hook = (event, target, value) => { if (event === "after-replace" && target.startsWith("state/") && typeof value === "string" && JSON.parse(value).original?.savedPath) allowed = false; };
    const stopped = await denied.service.start("Denied.pdf", pdf, { ...base, translation: true }, undefined, "denied", undefined, { assertCanWrite: async () => { if (!allowed) throw new Error("capability revoked"); } });
    assert.equal(stopped.state, "failed"); assert.ok(stopped.original!.savedPath); assert.equal(denied.counts().parses, 0);
    const aborted = fixture(), controller = new AbortController(); controller.abort();
    const cancelled = await aborted.service.start("Cancelled.pdf", pdf, base, controller.signal, "cancelled");
    assert.equal(cancelled.state, "cancelled"); assert.equal([...aborted.files.data.keys()].filter(target => target.endsWith(".pdf")).length, 0);
    const invalid = fixture(); const prepared = await invalid.service.prepareStartIntent("Invalid.pdf", pdf, base, "invalid-folder"); invalid.change({ allowedDirectory: false });
    await assert.rejects(() => invalid.service.start("Invalid.pdf", pdf, base, undefined, prepared.id, undefined, { intent: prepared }), /失效/u);
  }
  // Old jobs stay old even when reopened by the new desktop policy; bad records are reported separately.
  {
    const legacy = fixture(new MemoryFiles(), false);
    const old = await legacy.service.start("Old.pdf", pdf, base, undefined, "legacy");
    const f = fixture(legacy.files); const before = await f.files.read(statePath(old.id));
    await readonly(f.files, () => f.service.historyWithErrors()); assert.equal(await f.files.read(statePath(old.id)), before);
    const resumed = await f.service.resume(old.id, undefined, undefined, undefined, { conversationId: "do-not-backfill" });
    assert.equal(resumed.original, undefined); assert.equal(resumed.conversationId, undefined); assert.equal(resumed.createdAt, old.createdAt);
    assert.equal([...f.files.data.keys()].filter(target => target.endsWith(".pdf")).length, 0);
    f.files.data.set(statePath("corrupt"), "{broken");
    const history = await readonly(f.files, () => f.service.historyWithErrors()); assert.equal(history.jobs.length, 1); assert.equal(history.errors.length, 1);
  }
  // Independent output choices share one analysis pass; extraction-only never asks for a model.
  {
    for (const [id, options, generations] of [
      ["raw-only", base, 0], ["translation", { ...base, translation: true }, 1],
      ["reading", { ...base, reading: true, wiki: true }, 1], ["summary", { ...base, summary: true, wiki: true }, 1],
      ["both", { ...base, reading: true, summary: true, wiki: true }, 1]
    ] as const) {
      const f = fixture(), job = await f.service.start("Choices.pdf", pdf, options, undefined, id);
      assert.equal(job.state, "completed", job.error); assert.equal(f.counts().generations, generations, id);
      assert.equal(job.options.reading, options.reading); assert.equal(!!job.options.summary, !!options.summary);
      assert.equal(job.artifacts.some(item => item.kind === "raw"), true);
      assert.equal(job.artifacts.some(item => item.kind === "translation"), !!options.translation);
      if (options.reading || options.summary) assert.ok(job.chunks[0].reading);
      assert.equal(job.artifacts.some(item => item.kind === "reading" || item.kind === "wiki"), false, "internal analysis is not a published Knowledge file");
    }
  }
  console.log("PASS PDF storage: pure intent, durable ordering, exact binary readback, crash recovery, failures, conflicts, version/capability checks, old jobs and independent result choices.");
}

/** A host port for real PdfVaultFiles and Controller, with no native app or Provider. */
function vaultHost(root: string) {
  const data = new Map<string, string | Uint8Array>(), folders = new Map<string, TFolder>(), fileObjects = new Map<string, TFile>();
  const mutations: string[] = [], opens: string[] = [];
  const folder = (value: string): TFolder => {
    if (folders.has(value)) return folders.get(value)!;
    const item = Object.assign(Object.create(TFolder.prototype), { path: value, children: [] as (TFile | TFolder)[] }); folders.set(value, item);
    if (value) folder(value.includes("/") ? value.slice(0, value.lastIndexOf("/")) : "").children.push(item);
    return item;
  };
  const file = (value: string): TFile => {
    if (!fileObjects.has(value)) {
      const item = Object.assign(Object.create(TFile.prototype), { path: value, name: value.split("/").at(-1), extension: value.split(".").at(-1) });
      fileObjects.set(value, item); folder(value.slice(0, value.lastIndexOf("/"))).children.push(item);
    }
    return fileObjects.get(value)!;
  };
  ["raw", "raw/originals", "raw/nested-wiki", "wiki", "incoming"].forEach(folder);
  const bytes = (value: string) => { const item = data.get(value); if (!(item instanceof Uint8Array)) throw new Error("missing binary"); return new Uint8Array(item).buffer; };
  const app = { vault: {
    configDir: ".obsidian", getRoot: () => folder(""), getAbstractFileByPath: (value: string) => data.has(value) ? file(value) : folders.get(value) ?? null,
    adapter: {
      exists: async (value: string) => data.has(value) || folders.has(value), read: async (value: string) => { const item = data.get(value); if (typeof item !== "string") throw new Error("missing text"); return item; }, readBinary: async (value: string) => bytes(value),
      mkdir: async (value: string) => { mutations.push(`mkdir:${value}`); folder(value); },
      write: async (value: string, text: string) => { mutations.push(`state:${value}`); data.set(value, text); },
      process: async (value: string, update: (before: string) => string) => { const prior = data.get(value); if (typeof prior !== "string") throw new Error("missing state"); mutations.push(`state:${value}`); data.set(value, update(prior)); },
      list: async (directory: string) => ({ files: [...data.keys()].filter(value => value.startsWith(`${directory}/`) && !value.slice(directory.length + 1).includes("/")), folders: [] })
    },
    createFolder: async (value: string) => { mutations.push(`mkdir:${value}`); return folder(value); },
    create: async (value: string, text: string) => { assert.equal(data.has(value), false); mutations.push(`text:${value}`); data.set(value, text); return file(value); },
    createBinary: async (value: string, content: ArrayBuffer) => { assert.equal(data.has(value), false); mutations.push(`binary:${value}`); data.set(value, new Uint8Array(content).slice()); return file(value); },
    readBinary: async (item: TFile) => bytes(item.path),
    process: async (item: TFile, update: (before: string) => string) => { const prior = data.get(item.path); if (typeof prior !== "string") throw new Error("missing text"); mutations.push(`process:${item.path}`); data.set(item.path, update(prior)); }
  }, workspace: { getLeaf: () => ({ openFile: async (item: TFile) => { opens.push(item.path); } }), openLinkText: async (value: string) => { opens.push(value); } } } as unknown as App;
  const bindings = emptyKnowledgeFolderBindings();
  bindings.roles.raw = { ...bindings.roles.raw, enabled: true, readPaths: ["raw"], writePath: "raw" };
  bindings.roles.wiki = { ...bindings.roles.wiki, enabled: true, readPaths: ["raw/nested-wiki", "wiki"], writePath: "wiki" };
  let paid = true, parserCalls = 0;
  const plugin: any = { app, manifest: { id: "p10-fixture" }, getVaultPath: () => root,
    settings: { knowledgeBase: { folderBindings: bindings }, pdfReading: { enabled: true, engine: "local", mineruToken: "", translationLanguage: "中文", originalDirectory: "raw/originals" } },
    accountService: { checkCapability: () => paid, requireCapability: () => { if (!paid) throw new Error("expired PRO"); }, subscribe: () => () => {} },
    createPdfReadingGenerator: () => { throw new Error("navigation cannot initialize Provider"); }, readPdfKnowledgeArtifacts: async (): Promise<PdfNavigationArtifact[]> => [],
    readPiConversationCatalogEntry: async (id: string) => ({ conversationId: id, taskStatus: "running" }) };
  const host = new PdfReadingController(plugin);
  host.api.deps.local = async () => { parserCalls++; assert.ok([...data.keys()].some(value => value.endsWith(".pdf"))); return { pages: [{ number: 1, markdown: "Saved original source." }], images: [], warnings: [], engine: "local" }; };
  return { app, plugin, host, data, mutations, opens, bindings, folder, file, paid: (value: boolean) => { paid = value; }, parserCalls: () => parserCalls };
}
async function controllerAndPort(root: string): Promise<void> {
  await Promise.all(["raw", "raw/originals", "wiki"].map(value => mkdir(path.join(root, value), { recursive: true })));
  const f = vaultHost(root), release = registerKnowledgeFolderBindings(root, () => f.bindings);
  try {
    const outside = f.folder("unrelated"); Object.defineProperty(outside, "children", { get() { throw new Error("do not scan unrelated Vault trees"); } });
    assert.deepEqual(f.host.originalDirectories(), ["raw", "raw/originals"]); assert.equal(f.host.defaultOriginalDirectory(), "raw/originals");
    f.plugin.settings.pdfReading.originalDirectory = "wiki"; assert.equal(f.host.defaultOriginalDirectory(), ""); f.plugin.settings.pdfReading.originalDirectory = "raw/originals";
    const before = f.mutations.length;
    const intent = await f.host.api.prepareStartIntent("Desktop.pdf", pdf, base, "desktop", { conversationId: "task-desktop" });
    assert.equal(f.mutations.length, before);
    const job = await f.host.api.start("Desktop.pdf", pdf, base, undefined, intent.id, undefined, { intent, conversationId: "task-desktop" });
    assert.equal(job.state, "completed", job.error); assert.equal(f.parserCalls(), 1);
    assert.ok(job.original!.savedPath); assert.ok(f.data.get(job.original!.savedPath!) instanceof Uint8Array);
    const raw = job.artifacts.find(item => item.kind === "raw")!.path;
    f.data.set("wiki/topic.md", "# Topic\n\n## 精读\n\nEvidence.\n\n## 摘要\n\nConclusion."); f.file("wiki/topic.md");
    f.plugin.readPdfKnowledgeArtifacts = async (source: string) => { assert.equal(source, raw); return [
      { kind: "wiki", path: "wiki/topic.md", label: "知识成果" }, { kind: "reading", path: "wiki/topic.md#精读", label: "精读" }, { kind: "summary", path: "wiki/topic.md#摘要", label: "摘要" }
    ]; };
    job.options.summary = true; job.options.wiki = true; job.stage = "真实未持久化阶段";
    const readOnlySnapshot = structuredClone([...f.data]), priorMutations = f.mutations.length;
    const navigation = await f.host.navigationData(job.id);
    assert.equal(navigation.entries[0].job.stage, "真实未持久化阶段"); assert.equal(navigation.entries[0].originalState, "available"); assert.equal(navigation.entries[0].taskId, "task-desktop");
    assert.equal((navigation.entries[0] as typeof navigation.entries[0] & { taskStatus?: string }).taskStatus, "running", "Catalog task state is projected independently of the completed extraction step");
    assert.ok(navigation.entries[0].artifacts.some(item => item.kind === "wiki")); assert.ok(navigation.entries[0].artifacts.some(item => item.kind === "summary"));
    assert.equal(navigation.entries[0].artifacts.some(item => item.kind === "reading"), false);
    assert.equal(f.mutations.length, priorMutations); assert.deepEqual([...f.data], readOnlySnapshot);
    await f.host.openNote("wiki/topic.md#摘要"); assert.equal(f.opens.at(-1), "wiki/topic.md#摘要");
    const changed = new Uint8Array(pdf); changed[changed.length - 1] ^= 1; f.data.set(job.original!.savedPath!, changed);
    assert.equal((await f.host.navigationData(job.id)).entries[0].originalState, "changed");
    f.data.delete(job.original!.savedPath!); f.data.delete(raw);
    const missing = await f.host.navigationData(job.id); assert.equal(missing.entries[0].originalState, "missing");
    assert.equal(missing.entries[0].artifacts.find(item => item.kind === "raw")!.missing, true);
    f.paid(false); f.plugin.settings.pdfReading.enabled = false;
    assert.equal((await f.host.navigationData()).entries.length, 1); assert.equal(f.parserCalls(), 1);
    // Real vault port keeps binary copies immutable and preserves compare-before-replace protection.
    const port = new PdfVaultFiles(f.app, ".obsidian/private-state", true);
    await assert.rejects(() => port.create("raw/missing/new.pdf", pdf), /已失效/u);
    await port.create(".obsidian/private-state/job.json", "before");
    await assert.rejects(() => port.replace(".obsidian/private-state/job.json", "after", "wrong"), /已有变化/u);
    assert.equal(await port.read(".obsidian/private-state/job.json"), "before");
    f.paid(true); f.plugin.settings.pdfReading.enabled = true;
    // Real Controller validators stop publication when bindings change during parser/model awaits.
    for (const phase of ["parse", "model"] as const) {
      let finish: (() => void) | undefined;
      f.bindings.roles.raw.enabled = true;
      f.host.api.deps.local = async () => {
        if (phase === "parse") await new Promise<void>(resolve => { finish = resolve; });
        return { pages: [{ number: 1, markdown: "Source under the original Raw binding." }], images: [], warnings: [], engine: "local" };
      };
      f.host.api.deps.generator = () => ({ maxSourceCharacters: 1000, generate: async () => { await new Promise<void>(resolve => { finish = resolve; }); return "Generated before Raw scope was revoked."; } });
      const flight = f.host.api.start(`Binding-${phase}.pdf`, pdf, { ...base, translation: true }, undefined, `binding-${phase}`);
      await waitFor(() => !!finish);
      f.bindings.roles.raw.enabled = false; finish!();
      const blocked = await flight;
      assert.match(blocked.error!, /绑定范围|保存位置/u);
      assert.equal(blocked.artifacts.some(item => item.kind === "translation"), false);
      if (phase === "parse") assert.equal(blocked.artifacts.length, 0);
    }
    f.bindings.roles.raw.enabled = true;
  } finally { release(); }
  console.log("PASS real PDF controller/vault port: bound original directories, binary storage, read-only current-stage/history projection, verified original status, selected Wiki anchors and expired-PRO local reads.");
}
export async function runPdfNavigationStorageTests(root: string): Promise<void> {
  await serviceBoundaries(); await controllerAndPort(root);
  console.log("P10 PDF navigation storage: all targeted checks passed.");
}
