import { KnowledgeLinkingService } from "../plugin/knowledge-linking-service";
import { readKnowledgeLinkingDocument } from "../knowledge-base/knowledge-linking";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { nativeJournalFixture } from "./native-journal-fixture";
import { ObsidianVaultDomainAdapter } from "../plugin/obsidian-vault-domain-adapter";
import { VaultDomainService } from "../harness/pi-native/vault-domain-service";
import { ProductionPiKnowledgeMaintenanceToolPort, privateMaintenanceSourceScope, readPrivateMaintenanceRecords } from "../plugin/pi-knowledge-maintenance-production";
import { emptyKnowledgeFolderBindings, registerKnowledgeFolderBindings } from "../knowledge-base/root-paths";
import { rawDigestFingerprint } from "../knowledge-base/raw-digest";
import { isMaintenanceSourceProcessed } from "../knowledge-base/maintenance-source-state";
import { createMaintenanceSectionSnapshot } from "../knowledge-base/maintenance-section-patch";
import type { MaintenanceP1Action, MaintenanceWritingItem } from "../knowledge-base/maintenance-p1-contract";
import { backgroundMaintenancePageWrite, holdMaintenancePages, releaseMaintenancePages } from "../knowledge-base/maintenance-page-lock";
import { createPiKnowledgeMaintenanceToolSecurity, createPiKnowledgeMaintenanceToolDefinition } from "../harness/pi-native/pi-knowledge-maintenance-tool";
import { EchoInkVaultToolEgressPolicy } from "../harness/pi-native/vault-tool-result-safety";
import { buildKnowledgeBaseDashboardSnapshot } from "../knowledge-base/dashboard";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const pref = { profileVersion: "p1-fixture", state: "default" as const, revision: `sha256:${"a".repeat(64)}` };
const source = "raw/source.md", inbox = "inbox/idea.md";
const original = "---\n# Keep this comment\ntags: [fixture]\naliases: [native]\nother: 0021\n---\n# Synthetic source\nSpaced repetition strengthens recall.\n  Keep spaces.\n\n";
const newPage = "---\n类型: 概念\naliases: [Spaced repetition]\n---\n# 间隔复习\n间隔复习是分散时间进行复习的方法。\n\n## 方法\n逐步延长间隔。\n\n## 相关条目\n\n";

export async function runKnowledgeMaintainP1Tests(root: string): Promise<void> {
  const report: unknown[] = [];
  async function scenario(name: string, run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
    const f = await fixture(path.join(root, name));
    try { await run(f); report.push({ name, passed: true, vault: f.vault }); }
    finally { f.release(); }
  }
  await scenario("aggregate-raw-inbox", async f => {
    await f.write(inbox, original.replace("Synthetic source", "Inbox source"));
    const paths = [source, inbox];
    assert.equal((await f.call({ stage: "write", pageId: "one", content: newPage }, paths)).status, "failed", "no write before decompose+plan");
    await f.decompose(paths);
    assert.deepEqual((await privateMaintenanceSourceScope(f.vault)).sourcePaths, [inbox, source].sort(), "only state decides pending");
    const planned = await f.call({ stage: "plan", writingPlan: [f.item("one", "wiki/间隔复习.md", paths)] }, paths);
    assert.deepEqual(planned.processedSourcePaths, []);
    const records = await readPrivateMaintenanceRecords(f.privateRoot);
    assert.equal(records.length, 1, "one existing private record owns this job");
    await f.restart();
    const resumed = await f.call({ stage: "resume" }, paths);
    assert.match(resumed.message, /hasDraft":false/u, "cold resume returns unwritten page to same AgentSession");
    const written = await f.call({ stage: "write", pageId: "one", content: newPage }, paths);
    assert.equal(written.status, "completed", written.message);
    assert.deepEqual(written.processedSourcePaths, paths);
    const content = await f.read("wiki/间隔复习.md");
    for (const p of paths) { assert.ok(content.includes(`[[${p}|原始材料]]`)); assert.match(await f.read(p), /提炼到:.*"\[\[wiki\/间隔复习.md\]\]"/u); }
    const after = await f.read(source);
    assert.equal(after.slice(after.indexOf("---\n", 4) + 4), original.slice(original.indexOf("---\n", 4) + 4), "source body byte exact");
    assert.ok(after.includes("# Keep this comment\ntags: [fixture]\naliases: [native]\nother: 0021\n"));
    assert.deepEqual((await privateMaintenanceSourceScope(f.vault)).sourcePaths, []);
    await f.write(source, (await f.read(source)) + "Edited body but state stays completed.\n");
    assert.deepEqual((await privateMaintenanceSourceScope(f.vault)).sourcePaths, [], "scheme A does not rehash source for pending status");
    assert.equal((await readPrivateMaintenanceRecords(f.privateRoot)).length, 1, "per-page WALs do not create fake terminal records");
    const beforeCounts = [...f.writes]; await f.call({ stage: "resume" }, paths); assert.deepEqual(f.writes, beforeCounts);
  });
  await scenario("three-pages-second-fails", async f => {
    await f.decompose([source]);
    const items = ["first", "second", "third"].map(id => f.item(id, `wiki/${id}.md`, [source]));
    await f.call({ stage: "plan", writingPlan: items });
    let result = await f.call({ stage: "write", pageId: "first", content: newPage });
    assert.deepEqual(result.processedSourcePaths, []);
    f.failPath("wiki/second.md");
    result = await f.call({ stage: "write", pageId: "second", content: newPage.replaceAll("间隔复习", "第二知识点") });
    assert.equal(result.status, "failed");
    assert.equal(isMaintenanceSourceProcessed(await f.read(source)), false);
    const firstBefore = await f.read("wiki/first.md"), firstWrites = f.writes.filter(p => p === "wiki/first.md").length;
    f.failPath(null); await f.restart();
    result = await f.call({ stage: "resume" });
    assert.equal(result.status, "completed", result.message);
    assert.ok(await f.read("wiki/second.md"));
    assert.match(result.message, /third/u);
    assert.equal(isMaintenanceSourceProcessed(await f.read(source)), false);
    await f.call({ stage: "write", pageId: "third", content: newPage.replaceAll("间隔复习", "第三知识点") });
    assert.equal(await f.read("wiki/first.md"), firstBefore);
    assert.equal(f.writes.filter(p => p === "wiki/first.md").length, firstWrites, "actual cold resume never rewrites success");
    assert.equal(isMaintenanceSourceProcessed(await f.read(source)), true);
    assert.equal((await readPrivateMaintenanceRecords(f.privateRoot)).length, 1);
  });
  await scenario("backlink-only-resume-and-subset", async f => {
    await f.write(inbox, original); const paths = [source, inbox]; await f.decompose(paths);
    await f.call({ stage: "plan", writingPlan: [f.item("one", "wiki/shared.md", paths)] }, paths);
    f.failPath(inbox);
    const result = await f.call({ stage: "write", pageId: "one", content: newPage }, paths);
    assert.equal(result.status, "failed"); assert.equal(isMaintenanceSourceProcessed(await f.read(source)), true); assert.equal(isMaintenanceSourceProcessed(await f.read(inbox)), false);
    const pageWrites = f.writes.filter(p => p === "wiki/shared.md").length;
    const sourceWrites = f.writes.filter(p => p === source).length;
    f.failPath(null); await f.restart();
    const restored = await f.call({ stage: "resume" }, [inbox]);
    assert.equal(restored.status, "completed", restored.message);
    assert.equal(f.writes.filter(p => p === "wiki/shared.md").length, pageWrites, "backlink retry never rewrites committed Wiki");
    assert.equal(f.writes.filter(p => p === source).length, sourceWrites, "already-finalized Raw is skipped even when current scope shrinks");
    assert.equal(isMaintenanceSourceProcessed(await f.read(inbox)), true);
  });
  await scenario("existing-sections-and-conflict", async f => {
    const target = "wiki/existing.md";
    const before = "---\naliases: [保留]\ncustom: 07\n---\n# Existing\n旧导语。\n\n## 重名\n第一段  \n\n## 重名\n第二段。\n\n```md\n## 假标题\n```\n\n## 留存\nKeep trailing spaces.  \n\n";
    await f.write(target, before); await f.decompose([source]);
    const expectedTarget = { kind: "file" as const, contentRevision: `sha256:${sha(before)}` };
    let result = await f.call({ stage: "plan", writingPlan: [{ ...f.item("edit", target, [source]), expectedTarget }] });
    assert.equal(result.status, "failed", "model claiming hash is insufficient: must have real read evidence");
    await f.observeTarget(target);
    result = await f.call({ stage: "plan", writingPlan: [{ ...f.item("edit", target, [source]), expectedTarget }] }); assert.equal(result.status, "completed", result.message);
    const sections = await f.call({ stage: "sections", targetPath: target }); assert.deepEqual(sections.processedSourcePaths, []);
    const snapshot = JSON.parse(sections.message).snapshot;
    assert.equal(snapshot.regions.filter((r: any) => r.title === "重名").length, 2); assert.equal(snapshot.regions.some((r: any) => r.title === "假标题"), false);
    result = await f.call({ stage: "write", pageId: "edit", sectionPatches: [{ regionId: "wrong", operation: "replace", content: "误改" }] });
    assert.equal(result.status, "failed"); assert.match(result.message, /当前目录/u); assert.equal(await f.read(target), before);
    const intro = snapshot.regions.find((r: any) => r.kind === "introduction");
    result = await f.call({ stage: "write", pageId: "edit", sectionPatches: [{ regionId: intro.id, operation: "replace", content: "新导语。\n\n" }] });
    assert.equal(result.status, "completed", result.message);
    const after = await f.read(target), suffix = before.slice(intro.end);
    assert.ok(after.startsWith(before.slice(0, intro.contentStart))); assert.ok(after.includes(suffix), "all untouched sections and EOF spaces stay byte exact, sources appended independently");
    assert.equal(after.match(/echoink-source/g)?.length, 1);
  });
  await scenario("concurrent-target", async f => {
    const target = "wiki/existing.md", before = "# Existing\nOld lead.\n\n## Body\nKeep.\n";
    await f.write(target, before); await f.decompose([source]); await f.observeTarget(target);
    await f.call({ stage: "plan", writingPlan: [{ ...f.item("edit", target, [source]), expectedTarget: { kind: "file", contentRevision: `sha256:${sha(before)}` } }] });
    const sections = JSON.parse((await f.call({ stage: "sections", targetPath: target })).message).snapshot;
    await f.write(target, before + "User edit.\n");
    const result = await f.call({ stage: "write", pageId: "edit", sectionPatches: [{ regionId: sections.regions[1].id, operation: "replace", content: "bad" }] });
    assert.equal(result.status, "failed"); assert.equal(await f.read(target), before + "User edit.\n"); assert.equal(f.writes.length, 0);
  });
  await scenario("bom-crlf-source-version", async f => {
    const before = "\uFEFF" + original.replaceAll("\n", "\r\n"); await f.write(source, before);
    await f.decompose([source]); await f.call({ stage: "plan", writingPlan: [f.item("bom", "wiki/bom.md", [source])] });
    const result = await f.call({ stage: "write", pageId: "bom", content: newPage });
    assert.equal(result.status, "completed", result.message);
    const after = await f.read(source); assert.ok(after.startsWith("\uFEFF---\r\n"));
    assert.equal(rawDigestFingerprint(source, Buffer.from(after)), rawDigestFingerprint(source, Buffer.from(before)), "BOM frontmatter updates cannot change the source body version");
    assert.equal(after.slice(after.indexOf("---\r\n", 5) + 5), before.slice(before.indexOf("---\r\n", 5) + 5));
  });
  await scenario("zero-units-and-state-count", async f => {
    await f.decompose([source], []); f.failPath(source);
    const planned = await f.call({ stage: "plan", writingPlan: [] }); assert.equal(planned.status, "failed"); assert.equal(isMaintenanceSourceProcessed(await f.read(source)), false);
    f.failPath(null); await f.restart(); await f.call({ stage: "resume" }); assert.equal(isMaintenanceSourceProcessed(await f.read(source)), true);
    const dashboard = await buildKnowledgeBaseDashboardSnapshot(f.vault, { ...f.fixture.plugin.settings.knowledgeBase, folderBindings: f.config });
    assert.equal(dashboard.raw.digestStatus.pending, 0); assert.equal(dashboard.raw.digestStatus.digested, 1);
  });
  await scenario("scan-rejects-symlink-root", async f => {
    const outside = path.join(root, "outside-synthetic"); await fs.mkdir(outside, { recursive: true }); await fs.writeFile(path.join(outside, "outside.md"), "Synthetic outside bytes");
    await fs.symlink(outside, path.join(f.vault, "linked-source"));
    f.config.roles.raw.readPaths = ["linked-source"]; f.config.roles.raw.writePath = "linked-source";
    await assert.rejects(privateMaintenanceSourceScope(f.vault), /非普通目录或链接/u);
  });
  await assertBackgroundServiceGate(path.join(root, "service-gate"));
  await assertToolStageSecurity();
  const vaultA = path.join(root, "lock-a"), vaultB = path.join(root, "lock-b");
  holdMaintenancePages("p1-lock", vaultA, ["wiki/a.md"]);
  let same = 0, other = 0; const signal = new AbortController();
  const deferred = backgroundMaintenancePageWrite(vaultA, "wiki/a.md", async () => { same++; }, signal.signal);
  await backgroundMaintenancePageWrite(vaultB, "wiki/a.md", async () => { other++; }, signal.signal);
  assert.equal(same, 0); assert.equal(other, 1); releaseMaintenancePages("p1-lock"); await deferred; assert.equal(same, 1);
  report.push({ name: "stage-security-and-vault-scoped-background-gate", passed: true });
  await fs.writeFile(path.join(root, "p1-report.json"), JSON.stringify(report, null, 2));
  console.log(`P1 production maintenance: PASS (${report.length} scenarios)`);
}

async function fixture(vault: string) {
  const f = await nativeJournalFixture(vault);
  const privateRoot = path.join(vault, ".obsidian/plugins/echoink/knowledge");
  const config = emptyKnowledgeFolderBindings();
  for (const role of ["raw", "inbox", "wiki"] as const) { Object.assign(config.roles[role], { enabled: true, readPaths: [role], writePath: role }); await fs.mkdir(path.join(vault, role), { recursive: true }); }
  const release = registerKnowledgeFolderBindings(vault, () => config);
  await f.write(source, original);
  let failed: string | null = null, seq = 0;
  const writes: string[] = [], targets: Record<string, string> = {};
  let domain: VaultDomainService, port: ProductionPiKnowledgeMaintenanceToolPort;
  async function restart() {
    const adapter = new ObsidianVaultDomainAdapter(f.app, "p1-vault", vault);
    for (const method of ["createFile", "updateFile"] as const) {
      const original = adapter[method].bind(adapter);
      (adapter as any)[method] = async (target: any, ...args: any[]) => { if (target.relativePath === failed) throw new Error("Synthetic write fault"); const result = await (original as any)(target, ...args); writes.push(target.relativePath); return result; };
    }
    domain = new VaultDomainService(adapter, { allowMissingParentDirectories: true });
    port = new ProductionPiKnowledgeMaintenanceToolPort({ vaultRootPath: vault, privateKnowledgeRootPath: privateRoot, vaultId: "p1-vault", userId: "fixture", deviceId: "fixture", domainService: domain, automaticLinkingEnabled: () => false, dateKey: () => "2026-10-22" });
    await port.initialize();
  }
  await restart();
  async function call(p1: MaintenanceP1Action, paths = [source]) {
    const fingerprints: Record<string, string> = {};
    for (const p of paths) { const read = await domain.noteRead({ vaultId: "p1-vault", relativePath: p }); fingerprints[p] = read.snapshot.bodyFingerprint!; }
    return await port.execute({ vaultId: "p1-vault", conversationId: "conversation", piSessionId: "session", productRunId: `turn-${++seq}`, toolCallId: `call-${seq}`, mode: "maintain", request: "", sourcePaths: paths, sourceBodyFingerprints: fingerprints, observedTargetRevisions: targets, preferenceSnapshot: pref, folderBindingsRevision: config.revision, p1 });
  }
  return { vault, privateRoot, fixture: f, config, release, restart, call, writes, failPath: (p: string | null) => { failed = p; }, read: (p: string) => fs.readFile(path.join(vault, p), "utf8"), write: f.write,
    observeTarget: async (p: string) => { const read = await domain.noteRead({ vaultId: "p1-vault", relativePath: p }); targets[p] = `sha256:${read.snapshot.contentSha256}`; },
    item: (id: string, targetPath: string, sourcePaths: string[]): MaintenanceWritingItem => ({ id, targetPath, sourcePaths, expectedTarget: { kind: "missing" } }),
    decompose: async (paths = [source], units = ["spaced repetition"]) => { const r = await call({ stage: "decompose", decompositions: paths.map(sourcePath => ({ sourcePath, summary: "合成摘要", units })) }, paths); assert.equal(r.status, "completed", r.message); assert.deepEqual(r.processedSourcePaths, []); }
  };
}
async function assertToolStageSecurity() {
  const identity = { vaultId: "v", conversationId: "c", productRunId: "r", piSessionId: "p" };
  const security = createPiKnowledgeMaintenanceToolSecurity({ currentRunIdentity: () => identity, currentCommand: () => ({ mode: "maintain", request: "", scope: { mode: "batch", sourcePaths: [source, inbox] }, preference: { ...pref, providerResourceText: "fixture" } }), egress: new EchoInkVaultToolEgressPolicy() });
  const event = (id: string, args: object) => ({ type: "tool_call", toolName: "knowledge_maintain", toolCallId: id, input: args } as never);
  assert.ok(await security.handleToolCall(event("old", { candidateActions: [] }), undefined));
  assert.ok(await security.handleToolCall(event("scope", { stage: "resume", sourcePaths: [source] }), undefined));
  const args = { stage: "resume", sourcePaths: [source, inbox] }; assert.equal(await security.handleToolCall(event("new", args), undefined), undefined);
  let called = false;
  const tool = createPiKnowledgeMaintenanceToolDefinition({ security, port: { execute: async input => { called = true; assert.equal(input.p1?.stage, "resume"); return { status: "completed", message: "saved plan", processedSourcePaths: [] }; } } });
  await tool.execute("new", args as never, undefined as never, undefined as never, undefined as never);
  assert.equal(called, true);
}

async function assertBackgroundServiceGate(vaultRootPath: string) {
  const files = new Map([["wiki/source.md", "# Source\nAgent supports tools.\n"], ["wiki/Agent.md", "# Agent\nA concept.\n"]]);
  let writes = 0, writing!: () => void;
  const reachedWriting = new Promise<void>(resolve => { writing = resolve; });
  const service = new KnowledgeLinkingService({ vaultRootPath,
    async *documents() { for (const [p, text] of files) yield readKnowledgeLinkingDocument(p, text, `sha256:${sha(text)}`); },
    bindingSignature: () => "synthetic", canWrite: () => true,
    read: async p => files.get(p)!, write: async (p, before, after) => { assert.equal(files.get(p), before); files.set(p, after); writes++; },
    judge: async input => input.allowAliases ? [] : input.documents.map(d => ({ path: d.path, version: d.version, mentions: input.candidates.filter(c => c.path === d.path) }))
  }, { load: async () => null, save: async task => { if (task.phase === "writing") writing(); } });
  holdMaintenancePages("service-gate", vaultRootPath, ["wiki/source.md"]);
  await service.start("automatic", ["wiki/Agent.md"]);
  await reachedWriting; assert.equal(writes, 0, "real background service is paused on the maintained page");
  releaseMaintenancePages("service-gate"); await service.waitForIdle();
  assert.equal(writes, 1); assert.match(files.get("wiki/source.md")!, /\[\[wiki\/Agent.md\|Agent\]\]/u);
  await service.dispose();
}
