import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { WorkspaceError, WorkspaceService, WORKSPACE_ROOT, WORKSPACE_MAX_BYTES, workspacePath, workspaceDependencyPath, workspaceRevision, type WorkspaceFilePort } from "../../src/workspace/service";
import { buildWorkspacePreview, renderWorkspacePreview, WORKSPACE_PREVIEW_CSP, WORKSPACE_PREVIEW_SANDBOX } from "../../src/workspace/preview";
import { createWorkspaceTools } from "../../src/workspace/tools";
import { WorkspacePreviewView } from "../../src/workspace/view";
import { createDesktopWorkspacePathGuard } from "../../src/workspace/desktop-safety";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = WORKSPACE_ROOT;
const full = (value: string) => `${root}/${value}`;
function fixture(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial).map(([path, text]) => [full(path), text]));
  const folders = new Set(["EchoInk", root]);
  for (const path of files.keys()) { const parts = path.split("/"); for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/")); }
  const symlinks = new Set<string>(), reads: string[] = [], writes: string[] = [];
  let beforeRead: ((path: string) => void) | undefined, beforeProcess: (() => void) | undefined;
  const port: WorkspaceFilePort = {
    adapter: {
      async stat(path) {
        if (symlinks.has(path)) return { type: "folder", ctime: 0, mtime: 0, size: 0, isSymbolicLink: true } as never;
        if (folders.has(path)) return { type: "folder", ctime: 0, mtime: 0, size: 0 };
        return files.has(path) ? { type: "file", ctime: 0, mtime: 0, size: new TextEncoder().encode(files.get(path)!).length } : null;
      },
      async list(path) { return { files: [...files.keys()].filter(file => file.slice(0, file.lastIndexOf("/")) === path), folders: [] }; },
      async read(path) { reads.push(path); beforeRead?.(path); if (!files.has(path)) throw new Error("missing"); return files.get(path)!; },
      async mkdir(path) { folders.add(path); }
    },
    async create(path, content, guard) { guard(); if (files.has(path)) throw new Error("existing"); files.set(path, content); writes.push(path); },
    async process(path, change) { beforeProcess?.(); const changed = change(files.get(path)!); files.set(path, changed); writes.push(path); return changed; }
  };
  return { service: new WorkspaceService(port), port, files, folders, reads, writes, symlinks,
    setBeforeRead(fn: (path: string) => void) { beforeRead = fn; }, setBeforeProcess(fn: () => void) { beforeProcess = fn; } };
}
const failsWith = (code: WorkspaceError["code"]) => (error: unknown) => error instanceof WorkspaceError && error.code === code;
let passed = 0;
async function test(name: string, run: () => void | Promise<void>) { await run(); passed++; console.log(`ok ${name}`); }

await test("paths stay in fixed root and reject configuration/traversal aliases", () => {
  for (const path of ["/tmp/a.html", "../secret.md", ".obsidian/config.js", "a/../x.html", "a\\x.html", "https://x/a.js", "a/%2e%2e/x.md", "a//x.md", "a/.git/x.md", "a.md?key", "a. /x.md", "a.js\0", "file.json"])
    assert.throws(() => workspacePath(path), WorkspaceError, path);
  for (const path of ["demo.html", "site/site.css", "site.js", "笔记.md"]) assert.equal(workspacePath(path), full(path));
  assert.equal(workspacePath(full("demo.html")), full("demo.html"));
  assert.equal(workspaceDependencyPath("site/index.html", "../shared.css"), full("shared.css"));
  assert.throws(() => workspaceDependencyPath("index.html", "../private.js"), failsWith("unsafe_path"));
});
await test("create never overwrites and returns revision plus HTML preview path", async () => {
  const f = fixture({ "existing.md": "user" });
  await assert.rejects(f.service.create({ path: "existing.md", content: "model" }), failsWith("already_exists"));
  assert.equal(f.files.get(full("existing.md")), "user");
  const result = await f.service.create({ path: "site/index.html", content: "<button>Hi</button>" });
  assert.equal(result.previewPath, full("site/index.html"));
  assert.equal(result.contentRevision, workspaceRevision("<button>Hi</button>"));
  assert(f.folders.has(full("site")));
});
await test("simultaneous same-version updates admit one writer", async () => {
  const f = fixture({ "a.md": "before" }), before = await f.service.read({ path: "a.md" });
  const results = await Promise.allSettled(["one", "two"].map(content => f.service.update({ path: "a.md", content, expectedRevision: before.contentRevision })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected" && failsWith("source_changed")(result.reason)).length, 1);
  assert.equal(f.writes.length, 1);
});
await test("atomic update callback preserves edit after initial read", async () => {
  const f = fixture({ "a.md": "before" });
  f.setBeforeProcess(() => f.files.set(full("a.md"), "user typed"));
  await assert.rejects(f.service.update({ path: "a.md", content: "model", expectedRevision: workspaceRevision("before") }), failsWith("source_changed"));
  assert.equal(f.files.get(full("a.md")), "user typed"); assert.equal(f.writes.length, 0);
});
await test("permissions and cancellation are checked across async reads and process", async () => {
  const f = fixture({ "a.md": "secret" }); let permitted = true;
  f.setBeforeRead(() => { permitted = false; });
  await assert.rejects(f.service.read({ path: "a.md" }, () => { if (!permitted) throw new Error("revoked"); }), /revoked/u);
  const aborted = fixture({ "a.md": "before" }), controller = new AbortController();
  aborted.setBeforeProcess(() => controller.abort());
  await assert.rejects(aborted.service.update({ path: "a.md", content: "after", expectedRevision: workspaceRevision("before") }, undefined, controller.signal), failsWith("stopped"));
  assert.equal(aborted.files.get(full("a.md")), "before");
  const readonly = fixture();
  await assert.rejects(readonly.service.create({ path: "new.md", content: "x" }, () => { throw new Error("readonly"); }), /readonly/u);
  assert.equal(readonly.writes.length, 0);
});
await test("oversized UTF-8 text is rejected before creation or delivery", async () => {
  const content = "中".repeat(Math.ceil(WORKSPACE_MAX_BYTES / 3));
  const f = fixture({ "large.md": content });
  await assert.rejects(f.service.create({ path: "new.md", content }), failsWith("too_large"));
  await assert.rejects(f.service.read({ path: "large.md" }), failsWith("too_large"));
  assert.equal(f.writes.length, 0); assert.equal(f.reads.length, 0);
});
await test("link metadata and desktop adapters without canonical proof fail closed", async () => {
  const f = fixture({ "a.md": "secret" }); f.symlinks.add("EchoInk");
  await assert.rejects(f.service.read({ path: "a.md" }), failsWith("unsafe_path")); assert.equal(f.reads.length, 0);
  const desktop = fixture({ "a.md": "safe" }); desktop.port.requiresPathGuard = true;
  await assert.rejects(desktop.service.read({ path: "a.md" }), failsWith("unsafe_adapter"));
  let proofs = 0;
  const proven = new WorkspaceService(desktop.port, { assertSafePath: async (path, guard) => { guard(); assert.equal(path, full("a.md")); proofs++; guard(); } });
  assert.equal((await proven.read({ path: "a.md" })).content, "safe"); assert(proofs >= 2);
});
await test("desktop canonical guard rejects actual ancestor/file links and permits absent suffixes", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "echoink-workspace-path-test-")));
  try {
    await mkdir(path.join(directory, root), { recursive: true });
    const guard = createDesktopWorkspacePathGuard(directory); let checks = 0;
    await guard(full("new/site/index.html"), () => { checks++; }); assert(checks > 8);
    await writeFile(path.join(directory, "outside.md"), "private");
    await symlink(path.join(directory, "outside.md"), path.join(directory, root, "linked.md"));
    await assert.rejects(guard(full("linked.md"), () => {}), failsWith("unsafe_path"));
    await symlink(directory, path.join(directory, root, "escape"));
    await assert.rejects(guard(full("escape/outside.md"), () => {}), failsWith("unsafe_path"));
    let active = true;
    await assert.rejects(guard(full("new.html"), () => { if (!active) throw new Error("revoked"); active = false; }), /revoked/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
const dom = new JSDOM("<!doctype html><main></main>");
const document = dom.window.document;
Object.defineProperty(dom.window.Document.prototype, "win", { get() { return dom.window; }, configurable: true });
Object.assign(dom.window, { createEl: (tag: string) => document.createElement(tag), createDiv: () => document.createElement("div") });
await test("preview assembles relative CSS and classic JS in a policy-first document", async () => {
  const f = fixture({ "site/index.html": '<meta http-equiv="refresh" content="0;url=https://example.com"><base href="https://example.com"><link rel="stylesheet" href="../theme.css"><button id="b">Hi</button><script src="app.js"></script>', "theme.css": "body{color:red}", "site/app.js": "document.querySelector('#b').onclick=()=>document.querySelector('#b').textContent='Clicked';" });
  const result = await buildWorkspacePreview(document, f.service, "site/index.html");
  const parsed = new dom.window.DOMParser().parseFromString(result.srcdoc, "text/html");
  assert.equal(parsed.querySelector("meta[http-equiv]")?.getAttribute("content"), WORKSPACE_PREVIEW_CSP);
  assert.equal(parsed.querySelectorAll("meta[http-equiv]").length, 1); assert.equal(parsed.querySelector("base,link,script[src]"), null);
  assert.match(result.srcdoc, /body\{color:red\}/u); assert.match(result.srcdoc, /Clicked/u);
  assert.deepEqual(result.dependencies.map(file => file.path), [full("theme.css"), full("site/app.js")]);
  assert.equal(parsed.head.children[1].tagName, "META");
  assert.match(WORKSPACE_PREVIEW_CSP, /connect-src 'none'/u); assert.match(WORKSPACE_PREVIEW_CSP, /frame-src 'none'/u);
});
await test("preview rejects dependency escape, network CSS, CSS imports and JS modules", async () => {
  for (const html of ['<link rel="stylesheet" href="../../secret.css">', '<script src="https://example.com/a.js"></script>', '<style>@import "https://example.com/x.css";</style>', '<style>body{background:u\\72l(https://example.com)}</style>', '<style>body{background:url(https://example.com)}</style>', '<script>import("./x.js")</script>', '<script type="module">console.log(1)</script>', '<iframe src="https://example.com"></iframe>', '<img src="file:///etc/passwd">']) {
    const f = fixture({ "index.html": html });
    await assert.rejects(buildWorkspacePreview(document, f.service, "index.html"));
    assert(f.reads.every(path => path.startsWith(root + "/")));
    assert.equal(f.reads.length, 1);
  }
});
await test("preview DOM uses only scripts sandbox and mobile gets refresh alone", async () => {
  const f = fixture({ "index.html": "<button>Hello</button>" }), container = document.createElement("div");
  const controller = renderWorkspacePreview(document, container, f.service, "index.html");
  await controller.refresh();
  const frame = container.querySelector("iframe")!;
  assert.equal(frame.getAttribute("sandbox"), WORKSPACE_PREVIEW_SANDBOX); assert.equal(frame.getAttribute("sandbox"), "allow-scripts");
  assert.equal(frame.getAttribute("referrerpolicy"), "no-referrer"); assert.equal(container.querySelectorAll("button").length, 1);
  assert.match(frame.srcdoc, /Content-Security-Policy/u);
  controller.destroy(); assert.equal(container.childElementCount, 0);
});
await test("FileView loads and restores workspace HTML; outside files create no iframe or read", async () => {
  const f = fixture({ "index.html": "<p>Restored</p>", "wrong.md": "Not HTML" }), container = document.createElement("div");
  f.files.set("outside.html", "PRIVATE OUTSIDE CONTENT");
  const leaf = { contentEl: container, fileByPath: (path: string) => f.files.has(path) ? { path } : null } as unknown as ConstructorParameters<typeof WorkspacePreviewView>[0];
  const view = new WorkspacePreviewView(leaf, { service: f.service });
  assert.equal(view.canAcceptExtension("html"), true); assert.equal(view.canAcceptExtension("md"), false);
  await view.setState({ file: full("index.html") }, {});
  assert.deepEqual(view.getState(), { path: full("index.html"), file: full("index.html") });
  assert.equal(container.querySelectorAll("iframe").length, 1);
  await view.onUnloadFile(view.file!); assert.equal(container.childElementCount, 0);
  const readsBeforeOutside = f.reads.length;
  await view.setState({ file: "outside.html" }, {});
  assert.equal(container.querySelector("iframe"), null); assert.equal(f.reads.length, readsBeforeOutside);
  assert.match(container.textContent ?? "", /工作区/u);
  await view.setState({ file: full("wrong.md") }, {});
  assert.equal(container.querySelector("iframe"), null); assert.match(container.textContent ?? "", /HTML/u);
  await view.setState({ path: full("index.html") }, {});
  assert.equal(view.getState().path, full("index.html"));
  assert.equal(view.getState().file, full("index.html"));
  await view.onClose(); assert.equal(container.childElementCount, 0);
});
await test("explicit tool schemas expose versioned workspace operations only", async () => {
  const f = fixture({ "a.md": "before" }), tools = createWorkspaceTools(f.service, { guard: () => {} });
  assert.throws(() => createWorkspaceTools(f.service, undefined as never), failsWith("unsafe_adapter"));
  assert.deepEqual(tools.map(tool => tool.name), ["workspace_read", "workspace_create", "workspace_update"]);
  const read = await tools[0].execute("read", { path: "a.md" });
  assert.equal(JSON.parse((read.content[0] as { text: string }).text).contentRevision, workspaceRevision("before"));
  const created = await tools[1].execute("create", { path: "demo.html", content: "<p>Demo</p>" });
  assert.equal(JSON.parse((created.content[0] as { text: string }).text).previewPath, full("demo.html"));
});
dom.window.close();
console.log(`workspace tests: ${passed} passed`);
