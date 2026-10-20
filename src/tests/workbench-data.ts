import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { TFile } from "obsidian";
import { nativeJournalFixture } from "./native-journal-fixture";
import { paidTestAccess } from "./membership-access";
import { WorkbenchDataService } from "../home/workbench-data";
import { HomeWorkbenchDataService, defaultJournalTemplateChoice } from "../home/home-workbench-data";
import { journalTemplateBaseline, readWorkbenchJournalDay, recordWorkbenchJournalTemplate } from "../home/workbench-journal";
import { getWorkbenchRecordStore, localWorkbenchDate, recordWorkbenchReviewSaved, WorkbenchRecordStore, workbenchFingerprint, workbenchWeekKey } from "../home/workbench-records";
import { emptyKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { rawDigestFingerprint, writeRawDigestRegistry } from "../knowledge-base/raw-digest";
import { registerKnowledgeFolderBindings, registerKnowledgePrivateRoot } from "../knowledge-base/root-paths";
import { LifestyleStore } from "../lifestyle/store";
import { LifestyleFinanceService } from "../lifestyle/finance-service";
import { PdfReadingService } from "../pdf-reading/service";
import { ReviewManager } from "../review/manager";
import type { DomainReceipt } from "../harness/pi-native/domain-receipt-store";
import { preparePluginDataRoot } from "../plugin/plugin-data-paths";
import { readNativeJournalContext } from "../home/native-journal";

function events() {
  const listeners = new Map<string, Set<(a?: any, b?: any) => void>>();
  return {
    on(name: string, callback: (a?: any, b?: any) => void) { const group = listeners.get(name) ?? new Set(); group.add(callback); listeners.set(name, group); return { name, callback }; },
    offref(ref: { name: string; callback: (a?: any, b?: any) => void }) { listeners.get(ref.name)?.delete(ref.callback); },
    emit(name: string, a?: unknown, b?: unknown) { for (const listener of listeners.get(name) ?? []) listener(a, b); }
  };
}

async function fixture(root: string) {
  const f = await nativeJournalFixture(root), app = f.app as any, plugin = f.plugin;
  const vaultEvents = events(), cacheEvents = events();
  app.vault.configDir = ".obsidian";
  app.workspace.layoutReady = true;
  app.vault.on = vaultEvents.on; app.vault.offref = vaultEvents.offref;
  app.metadataCache.on = cacheEvents.on; app.metadataCache.offref = cacheEvents.offref;
  let cacheReady = false;
  app.metadataCache.getFileCache = () => cacheReady ? {} : null;
  app.metadataCache.getFirstLinkpathDest = (link: string, source: string) => app.vault.getAbstractFileByPath(link)
    ?? app.vault.getAbstractFileByPath(path.posix.join(path.posix.dirname(source), link));
  const nativeCreate = app.vault.create.bind(app.vault);
  app.vault.create = async (target: string, content: string) => { const file = await nativeCreate(target, content); vaultEvents.emit("create", file); return file; };
  const nativeProcess = app.vault.process.bind(app.vault);
  app.vault.process = async (file: TFile, change: (source: string) => string) => { const content = await nativeProcess(file, change); vaultEvents.emit("modify", file); return content; };
  const bindings = emptyKnowledgeFolderBindings();
  for (const role of ["raw", "wiki", "projects", "inbox", "journal", "templates", "assets", "outputs"] as const) {
    await fsp.mkdir(path.join(root, role), { recursive: true });
    bindings.roles[role] = { enabled: true, readPaths: [role], writePath: role, allowedSubdirectories: [] };
  }
  bindings.roles.journal.native = true;
  plugin.settings.knowledgeBase.folderBindings = bindings;
  const unregister = registerKnowledgeFolderBindings(root, () => bindings);
  registerKnowledgePrivateRoot(root, path.join(root, ".obsidian/plugins/codex-echoink/pi-agent-product-v1/knowledge"));
  plugin.manifest = { id: "codex-echoink" };
  plugin.accountService = paidTestAccess;
  plugin.settings.lifestyle.finance.enabled = true;
  plugin.settings.pdfReading.enabled = true;
  plugin.settings.englishDiary.enabled = true;
  plugin.settings.review.openHtmlAfterRun = false;
  plugin.settings.review.outputDir = "outputs/reviews";
  f.records["daily-notes"].instance.options = { folder: "journal", format: "YYYY-MM-DD", template: "templates/current.md" };
  f.records.templates.instance.options = { folder: "templates" };
  await f.write("templates/current.md", "---\ntemplate: 合成\n---\n# {{date:YYYY-MM-DD}}\n\n## 回顾\n\n请记录今天的事\n");
  const tasks: any[] = [], receipts = new Map<string, DomainReceipt[]>(), maintenance: any[] = [];
  plugin.listPiConversations = async () => tasks;
  plugin.readPiConversationCatalogEntry = async (id: string) => tasks.find(task => task.conversationId === id) ?? null;
  plugin.readWorkbenchTaskReceipts = async (id: string) => receipts.get(id) ?? [];
  plugin.getKnowledgeSurfaceService = () => ({ async getMaintenanceRecords() { return maintenance; }, async getDashboardSnapshot() { return null; } });
  const store = new LifestyleStore(path.join(root, ".obsidian/plugins/codex-echoink/lifestyle.json")); await store.initialize();
  const finance = new LifestyleFinanceService({ plugin, store, refresh() {} } as any, paidTestAccess);
  plugin.lifestyle = { store, finance };
  const pdfRoot = path.join(root, ".obsidian/plugins/codex-echoink/pdf-reading");
  const pdf = new PdfReadingService({
    async listJobs() { try { return (await fsp.readdir(pdfRoot)).filter(name => name.endsWith(".json")).map(name => name.slice(0, -5)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } },
    read: target => fsp.readFile(path.join(root, target), "utf8"), exists: async target => fsp.stat(path.join(root, target)).then(() => true, () => false),
    async create() { throw new Error("snapshot must not create PDF jobs"); }, async replace() { throw new Error("snapshot must not write PDF jobs"); }, roots: () => ["raw"]
  }, ".obsidian/plugins/codex-echoink/pdf-reading", { access: paidTestAccess, enabled: () => true,
    async local() { throw new Error("No model or PDF generation expected"); }, async enhanced() { throw new Error("No network expected"); },
    generator() { throw new Error("No Provider expected"); } });
  plugin.pdfReading = { api: pdf };
  const write = async (target: string, content: string) => { const existed = app.vault.getAbstractFileByPath(target); const file = await f.write(target, content); vaultEvents.emit(existed ? "modify" : "create", file); return file; };
  return { ...f, root, app, plugin, bindings, tasks, receipts, maintenance, store, finance, pdfRoot, write,
    resolveLinks(graph: Record<string, Record<string, number>> = {}) { cacheReady = true; app.metadataCache.resolvedLinks = Object.fromEntries(app.vault.getMarkdownFiles().map((file: TFile) => [file.path, graph[file.path] ?? {}])); cacheEvents.emit("resolved"); },
    invalidateLinks() { cacheEvents.emit("changed"); },
    async move(from: string, to: string) { await fsp.mkdir(path.dirname(path.join(root, to)), { recursive: true }); await app.fileManager.renameFile(app.vault.getAbstractFileByPath(from), to); vaultEvents.emit("rename", app.vault.getAbstractFileByPath(to), from); },
    unregister
  };
}

async function userFileContents(f: Awaited<ReturnType<typeof fixture>>): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(f.app.vault.getFiles().map(async (file: TFile) => [file.path, await f.app.vault.read(file)])));
}
function receipt(target: string, at: number, command = "create"): DomainReceipt {
  return { toolId: "note_create", status: "completed", recordedAt: at, resolvedTarget: { command, path: target }, readback: { readbackVerified: true, checkedAt: at, observedTargetVersion: null, safeSummary: null } } as DomainReceipt;
}
export async function runWorkbenchDataTests(root: string): Promise<void> {
  const now = new Date(2026, 9, 16, 18, 30).getTime(), today = localWorkbenchDate(now);
  const f = await fixture(path.join(root, "snapshots"));
  await f.write("inbox/old.md", "首次观察前的旧内容");
  await f.write("EchoInk/待办.md", `- [ ] 今天到期\n  - 截止日期：${today}\n- [ ] 长期逾期\n  - 截止日期：2026-10-12\n- [x] 已完成\n  - 截止日期：${today}\n`);
  for (let index = 1; index <= 5; index++) await f.write(`wiki/${index}.md`, `# 合成知识 ${index}`);
  await f.write("outside.md", "范围外引用");
  const before = await userFileContents(f), service = new WorkbenchDataService(f.plugin);
  let snapshot = await service.load(now);
  assert.deepEqual(await userFileContents(f), before, "loading does not create or alter any user files");
  assert.equal(snapshot.todayTodos.length, 1); assert.equal(snapshot.todayTodos[0].title, "今天到期");
  assert.ok(snapshot.signals.some(signal => signal.id === 1)); assert.ok(snapshot.signals.some(signal => signal.id === 2));
  assert.ok(!snapshot.signals.some(signal => signal.id === 6), "pre-observation inbox content is unknown, not newly added");
  assert.ok(!snapshot.signals.some(signal => signal.id === 14), "unresolved metadata cannot manufacture isolated notes");
  f.resolveLinks(); snapshot = await service.load(now); assert.ok(snapshot.signals.some(signal => signal.id === 14));
  f.resolveLinks({ "outside.md": { "wiki/1.md": 1 }, "wiki/2.md": { "outside.md": 1 } });
  assert.ok(!(await service.load(now)).signals.some(signal => signal.id === 14), "full-Vault edges in either direction count");
  f.resolveLinks({ "wiki/1.md": { "wiki/1.md": 1, "assets/photo.png": 1, "https://example.com": 1 } });
  assert.ok((await service.load(now)).signals.some(signal => signal.id === 14), "self-links, assets and URLs do not connect Markdown notes");
  f.invalidateLinks(); assert.ok(!(await service.load(now)).signals.some(signal => signal.id === 14));

  for (let index = 1; index <= 3; index++) await f.write(`inbox/new-${index}.md`, `已知新内容 ${index}`);
  snapshot = await service.load(Date.now());
  const inbox = snapshot.signals.find(signal => signal.id === 6)!; assert.ok(inbox); assert.equal(inbox.source.objects.length, 3);
  f.tasks.push({ conversationId: "inbox-task", taskStatus: "running", businessKey: inbox.key });
  await service.recordTaskAccepted("inbox-task", inbox.source);
  assert.ok(!(await service.load(Date.now())).signals.some(signal => signal.id === 6));
  f.tasks[0].taskStatus = "completed"; await service.recordTaskCompleted("inbox-task");
  assert.ok((await service.load(Date.now())).signals.some(signal => signal.id === 6), "task success alone cannot claim all Inbox inputs were processed");
  await f.move("inbox/new-1.md", "inbox/renamed.md");
  assert.ok((await service.load(Date.now())).signals.some(signal => signal.id === 6), "renaming inside Inbox preserves the original arrival");
  await f.move("inbox/renamed.md", "wiki/organized.md");
  assert.ok(!(await service.load(Date.now())).signals.some(signal => signal.id === 6), "only the actually moved item is removed");
  const records = getWorkbenchRecordStore(f.root);
  let persisted = await new WorkbenchRecordStore(records.filePath).snapshot();
  assert.ok(Object.values(persisted.inbox).some(scope => Object.values(scope.entries).some(item => item.processed?.resultPath === "wiki/organized.md")), "native move success survives reload");
  await f.write("inbox/new-4.md", "稍后加入");
  const again = (await service.load(Date.now())).signals.find(signal => signal.id === 6)!; assert.equal(again.source.objects.length, 3);
  await service.recordTaskAccepted("inbox-task", again.source);
  await f.write("inbox/new-5.md", "任务受理后加入，不在原输入快照");
  await fsp.unlink(path.join(f.root, "inbox/new-2.md"));
  await f.write("wiki/copied.md", "已知新内容 2");
  f.receipts.set("inbox-task", [receipt("wiki/copied.md", Date.now())]);
  await service.recordTaskCompleted("inbox-task");
  persisted = await new WorkbenchRecordStore(records.filePath).snapshot();
  assert.ok(Object.values(persisted.inbox).some(scope => scope.entries["inbox/new-2.md"]?.processed?.resultPath === "wiki/copied.md"));
  assert.ok(Object.values(persisted.inbox).every(scope => !scope.entries["inbox/new-5.md"]?.processed), "new arrivals during a run are never swept into its success");
  const binaryRead = f.app.vault.readBinary.bind(f.app.vault), readPaths: string[] = [];
  f.app.vault.readBinary = async (file: TFile) => { readPaths.push(file.path); return binaryRead(file); };
  await f.write("inbox/new-3.md", "只修改这一项");
  await (service as any).observationQueue;
  assert.deepEqual(readPaths, ["inbox/new-3.md"], "a native file event must not hash the entire Inbox in the background");
  f.app.vault.readBinary = binaryRead;
  service.dispose();
  const reloaded = new WorkbenchDataService(f.plugin);
  assert.ok((await reloaded.load(Date.now())).signals.some(signal => signal.id === 6), "new unprocessed items persist across service reload");
  f.bindings.roles.inbox.readPaths = ["other-inbox"]; f.bindings.roles.inbox.writePath = "other-inbox";
  await fsp.mkdir(path.join(f.root, "other-inbox")); await f.write("other-inbox/history.md", "另一个范围里的旧内容");
  assert.ok(!(await reloaded.load(Date.now())).signals.some(signal => signal.id === 6), "binding changes get their own baseline");

  for (let index = 1; index <= 3; index++) await f.write(`raw/${index}.md`, `# 来源\n\n可读来源 ${index}`);
  snapshot = await reloaded.load(now); assert.ok(snapshot.signals.some(signal => signal.id === 7));
  const rawPath = "raw/1.md", rawBytes = Buffer.from(await f.app.vault.read(f.app.vault.getAbstractFileByPath(rawPath))), fingerprint = rawDigestFingerprint(rawPath, rawBytes);
  await writeRawDigestRegistry(f.root, { schemaVersion: 1, updatedAt: new Date(now).toISOString(), entries: { [rawPath]: {
    rawPath, fingerprint, size: rawBytes.length, mtime: 0, digestedAt: now, runId: "synthetic", reportPath: "", evidencePaths: [], confidence: "verified"
  } } });
  assert.ok(!(await reloaded.load(now)).signals.some(signal => signal.id === 7), "the actual digest registry closes a current version");
  await f.write(rawPath, "来源当前版本改过了"); assert.ok((await reloaded.load(now)).signals.some(signal => signal.id === 7));
  f.plugin.settings.knowledgeBase.processedSources[rawPath] = { size: 1, mtime: Date.now() };
  assert.ok((await reloaded.load(now)).signals.some(signal => signal.id === 7), "old mtime/boolean hints cannot prove processing");
  f.maintenance.push({ at: Date.now(), sources: [{ path: rawPath, fingerprint: rawDigestFingerprint(rawPath, Buffer.from("来源当前版本改过了")), status: "processed" }] });
  assert.ok(!(await reloaded.load(now)).signals.some(signal => signal.id === 7), "a current-version reviewed source needs no new Wiki output");

  const journalData = new HomeWorkbenchDataService(f.app, () => "journal", null, undefined, () => f.bindings);
  const created = await journalData.createOrOpenJournal(defaultJournalTemplateChoice(), new Date(now)); assert.equal(created.created, true);
  snapshot = await reloaded.load(now);
  assert.ok((await new WorkbenchRecordStore(records.filePath).snapshot()).journals[created.file.path]);
  assert.ok(snapshot.signals.some(signal => signal.id === 10)); assert.ok(!snapshot.signals.some(signal => signal.id === 4));
  const initialTemplate = await f.app.vault.read(created.file);
  await f.write(created.file.path, `${initialTemplate}\n## 今天拿到了录用通知`);
  assert.ok((await reloaded.load(now)).signals.some(signal => signal.id === 5), "a new meaningful heading beyond the known template is journal content");
  await f.write(created.file.path, `${await f.app.vault.read(created.file)}\n今天写下真实的合成正文。`);
  snapshot = await reloaded.load(now); assert.ok(snapshot.signals.some(signal => signal.id === 5)); assert.ok(!snapshot.signals.some(signal => signal.id === 10));
  const englishRoot = path.join(f.root, ".obsidian/plugins/codex-echoink/english-diary");
  assert.equal(await fsp.stat(englishRoot).then(() => true, () => false), false, "checking a missing English association does not create one");
  await fsp.mkdir(englishRoot, { recursive: true });
  await fsp.writeFile(path.join(englishRoot, "a".repeat(24) + ".json"), JSON.stringify({ schema: 1, sourcePath: created.file.path, englishPath: "outputs/english.md", result: { sourceFingerprint: "old-version" }, transaction: null }));
  await f.write("outputs/english.md", "# English diary\n\nA saved synthetic English draft.");
  assert.ok(!(await reloaded.load(now)).signals.some(signal => signal.id === 5), "a linked saved draft remains valid after a source edit");
  const abstractFile = f.app.vault.getAbstractFileByPath.bind(f.app.vault);
  f.app.vault.getAbstractFileByPath = (target: string) => target === "outputs/english.md" ? null : abstractFile(target);
  assert.ok(!(await reloaded.load(now)).signals.some(signal => signal.id === 5), "legacy associated files remain readable when absent from the visible Vault index");
  f.app.vault.getAbstractFileByPath = abstractFile;
  await f.write("outputs/english.md", "---\ndate: 2026-10-16\n---\n# Empty title");
  assert.ok((await reloaded.load(now)).signals.some(signal => signal.id === 5));
  await f.write("assets/photo.png", "synthetic-image-bytes");
  await f.write(created.file.path, `# ${today}\n![[assets/photo.png]]`);
  const image = await readWorkbenchJournalDay(f.app, new Date(now), { bindings: f.bindings, baseline: journalTemplateBaseline(`# ${today}`) });
  assert.equal(image.state, "body"); assert.equal(image.text, "");
  const decorative = await readWorkbenchJournalDay(f.app, new Date(now), { bindings: f.bindings, baseline: journalTemplateBaseline(`# ${today}\n![[assets/photo.png]]`) }); assert.equal(decorative.state, "empty");
  await f.write("journal/2026-10-15.md", "旧自定义模板留下的提示，无法核实");
  const unknown = await readWorkbenchJournalDay(f.app, new Date(2026, 9, 15), { bindings: f.bindings }); assert.equal(unknown.state, "unknown");
  await f.write("journal/2026-10-14.md", "---\ndate: 2026-10-14\n---\n# 2026-10-14\n## 空章节\n<!-- 注释 -->");
  assert.equal((await readWorkbenchJournalDay(f.app, new Date(2026, 9, 14), { bindings: f.bindings })).state, "unknown", "unknown historical headings must not be declared empty");
  await f.write("journal/2026-10-14.md", "---\ndate: 2026-10-14\n---\n# 2026-10-14\n<!-- 注释 -->");
  assert.equal((await readWorkbenchJournalDay(f.app, new Date(2026, 9, 14), { bindings: f.bindings })).state, "empty");

  const review = new ReviewManager(f.plugin), currentRange = { startDate: "2026-10-12", endDate: "2026-10-16", startAt: new Date(2026, 9, 12).getTime(), endAt: now };
  const result = await review.runReview("agent-chat", currentRange); assert.equal(result.status, "success");
  assert.ok(!(await reloaded.load(now)).signals.some(signal => signal.id === 9));
  await recordWorkbenchReviewSaved(f.app, { startDate: "2026-10-05", endDate: "2026-10-11" }, "outputs/old-review.md", now + 1);
  assert.ok(!(await reloaded.load(new Date(2026, 9, 17, 12).getTime())).signals.some(signal => signal.id === 9), "finishing an old week does not erase the current week's fact");
  persisted = await new WorkbenchRecordStore(records.filePath).snapshot(); assert.ok(persisted.reviews["2026-10-12"] && persisted.reviews["2026-10-05"]);

  await f.store.update(draft => { draft.budgets = [{ month: "2026-10", totalCents: 10000, allocations: { 餐饮: 10000 } }]; draft.lastSuccessfulImportAt = now - 721 * 3600000; });
  await f.finance.ledger.add({ id: "signal-expense", source: "wechat", sourceId: "synthetic", date: today, merchant: "合成商户", kind: "expense", amountCents: 8000, category: "餐饮", classificationPending: true,
    status: "completed", currency: "CNY", account: "合成账户", description: "", note: "" });
  snapshot = await reloaded.load(now); assert.ok([3, 11, 13].every(id => snapshot.signals.some(signal => signal.id === id)));
  const beforeSnapshot = await userFileContents(f); await reloaded.load(now); assert.deepEqual(await userFileContents(f), beforeSnapshot, "financial snapshots do not create a Base or mutate ledger notes");
  f.plugin.accountService = { checkCapability: () => false, subscribe: () => () => {} };
  const financeRead = f.finance.ledger.readSnapshots.bind(f.finance.ledger), pdfHistory = f.plugin.pdfReading.api.history.bind(f.plugin.pdfReading.api);
  const englishReader = reloaded as unknown as { readEnglishMissing(target: string): Promise<boolean> };
  const englishRead = englishReader.readEnglishMissing.bind(reloaded);
  let deniedReads = 0;
  f.finance.ledger.readSnapshots = async () => { deniedReads++; throw new Error("must not read locked finance"); };
  f.plugin.pdfReading.api.history = async () => { deniedReads++; throw new Error("must not read locked PDF history"); };
  englishReader.readEnglishMissing = async () => { deniedReads++; throw new Error("must not read locked English drafts"); };
  snapshot = await reloaded.load(now); assert.ok([3, 5, 8, 11, 13].every(id => !snapshot.signals.some(signal => signal.id === id)));
  assert.ok(["finance", "english-diary", "pdf-reading"].every(id => snapshot.modules.includes(id as "finance")));
  assert.deepEqual(snapshot.lockedModules, ["finance", "english-diary", "pdf-reading"]);
  assert.equal(deniedReads, 0, "discoverable locked modules never read module data or emit paid signals");
  assert.equal(f.plugin.settings.lifestyle.finance.enabled, true);
  assert.equal(f.plugin.settings.englishDiary.enabled, true);
  assert.equal(f.plugin.settings.pdfReading.enabled, true);
  f.plugin.settings.lifestyle.finance.enabled = false; f.plugin.settings.englishDiary.enabled = false; f.plugin.settings.pdfReading.enabled = false;
  snapshot = await reloaded.load(now);
  assert.ok(["finance", "english-diary", "pdf-reading"].every(id => !snapshot.modules.includes(id as "finance")), "only a saved disabled module disappears");
  f.plugin.accountService = paidTestAccess;
  snapshot = await reloaded.load(now);
  assert.ok([3, 5, 8, 11, 13].every(id => !snapshot.signals.some(signal => signal.id === id)), "valid PRO still intersects the saved enable flags");
  f.finance.ledger.readSnapshots = financeRead; f.plugin.pdfReading.api.history = pdfHistory; englishReader.readEnglishMissing = englishRead;
  f.plugin.settings.lifestyle.finance.enabled = true; f.plugin.settings.englishDiary.enabled = true; f.plugin.settings.pdfReading.enabled = true;
  snapshot = await reloaded.load(now);
  assert.deepEqual(snapshot.lockedModules, []);
  assert.ok([3, 11, 13].every(id => snapshot.signals.some(signal => signal.id === id)), "restored PRO resumes the original real-data signals");
  assert.equal(f.providerCalls(), 0);
  reloaded.dispose(); f.unregister();

  const agent = await fixture(path.join(root, "agent-review")), agentService = new WorkbenchDataService(agent.plugin);
  await agentService.load(now);
  const prepared = await readNativeJournalContext(agent.app, { now: new Date(now), bindings: agent.bindings });
  await fsp.mkdir(path.dirname(path.join(agent.root, prepared.targetPath)), { recursive: true });
  await agent.app.vault.create(prepared.targetPath, `${prepared.templateContent}\nAgent正式写入的合成日记正文。`);
  const withAgentJournal = await agentService.load(now);
  assert.ok(withAgentJournal.signals.some(signal => signal.id === 5), "a real native creation using a prepared template records its baseline without trusting model prose");
  const source = (await agentService.load(now)).signals.find(signal => signal.id === 9)!.source;
  agent.tasks.push({ conversationId: "formal-review", taskStatus: "completed" });
  await agentService.recordTaskAccepted("formal-review", source); await agentService.recordTaskCompleted("formal-review");
  assert.ok((await agentService.load(now)).signals.some(signal => signal.id === 9), "a completed chat without saved output is not a review");
  await agent.write("outputs/agent-week-review.md", "# 本周回顾\n\n明确针对2026-10-12这一周的已保存成果。");
  agent.receipts.set("formal-review", [receipt("outputs/agent-week-review.md", Date.now())]);
  await agentService.recordTaskCompleted("formal-review");
  assert.ok(!(await agentService.load(now)).signals.some(signal => signal.id === 9));
  const durable = await new WorkbenchRecordStore(getWorkbenchRecordStore(agent.root).filePath).snapshot();
  assert.equal(durable.reviews[workbenchWeekKey(now)].taskId, "formal-review");
  assert.equal(durable.tasks["formal-review"].source.businessKey, source.businessKey, "accepted source survives disk reload");
  agentService.dispose(); agent.unregister();

  const custom = await fixture(path.join(root, "custom-plugin-path"));
  custom.app.vault.configDir = ".test-config";
  custom.plugin.manifest = { id: "custom-echoink", dir: ".test-config/plugins/custom-echoink" };
  custom.plugin.getPluginDataDirName = () => custom.plugin.manifest.dir;
  const dataRoot = await preparePluginDataRoot(custom.root, custom.plugin.manifest, custom.app.vault.configDir);
  const customService = new WorkbenchDataService(custom.plugin);
  await customService.load(now);
  await recordWorkbenchJournalTemplate(custom.app, "journal/custom.md", "# Custom template");
  await recordWorkbenchReviewSaved(custom.app, currentRange, "outputs/custom-review.md", now);
  const expectedStore = path.join(dataRoot.rootPath, "workbench-records.json");
  const customSaved = await new WorkbenchRecordStore(expectedStore).snapshot();
  assert.ok(customSaved.journals["journal/custom.md"] && customSaved.reviews["2026-10-12"], "journal, ReviewManager and data service share the prepared custom plugin data root");
  assert.equal(await fsp.stat(path.join(custom.root, ".obsidian/plugins/codex-echoink/workbench-records.json")).then(() => true, () => false), false, "custom installs must not create a second default workbench store");
  customService.dispose(); dataRoot.dispose(); custom.unregister();

  const refresh = await fixture(path.join(root, "refresh-cache"));
  await refresh.write("inbox/history.md", "首次观测前");
  for (let index = 1; index <= 3; index++) await refresh.write(`raw/${index}.md`, `当前资料 ${index}`);
  const refreshService = new WorkbenchDataService(refresh.plugin);
  await refreshService.load(now);
  for (let index = 1; index <= 3; index++) await refresh.write(`inbox/new-${index}.md`, `已知新增 ${index}`);
  let refreshed = await refreshService.load(Date.now());
  assert.ok(refreshed.signals.some(signal => signal.id === 6) && refreshed.signals.some(signal => signal.id === 7));
  const readSource = refresh.app.vault.readBinary.bind(refresh.app.vault), reads: string[] = [];
  refresh.app.vault.readBinary = async (file: TFile) => { reads.push(file.path); return readSource(file); };
  await Promise.all([refreshService.load(Date.now()), refreshService.load(Date.now())]);
  assert.deepEqual(reads, [], "consecutive and concurrent foreground refreshes reuse unchanged Inbox and Raw content");
  const oldRawVersion = refreshed.signals.find(signal => signal.id === 7)!.source.versions!["raw/1.md"];
  await refresh.write("raw/1.md", "这份资料已经修改，其他资料未变化");
  refreshed = await refreshService.load(Date.now());
  assert.deepEqual(reads, ["raw/1.md"], "a Raw modify event re-reads only that file");
  const rawVersion = refreshed.signals.find(signal => signal.id === 7)!.source.versions!["raw/1.md"];
  assert.notEqual(rawVersion, oldRawVersion);
  assert.equal(rawVersion, rawDigestFingerprint("raw/1.md", Buffer.from("这份资料已经修改，其他资料未变化")));
  reads.length = 0;
  await refresh.write("inbox/new-1.md", "修改了新增条目的当前版本");
  refreshed = await refreshService.load(Date.now());
  assert.deepEqual(reads, ["inbox/new-1.md"], "an Inbox event and its following foreground refresh share the one new read");
  assert.equal(refreshed.signals.find(signal => signal.id === 6)!.source.versions!["inbox/new-1.md"], workbenchFingerprint("修改了新增条目的当前版本"));
  reads.length = 0;
  await fsp.writeFile(path.join(refresh.root, "raw/2.md"), "未收到宿主事件，但stat的大小和修改时间已改变的资料");
  refreshed = await refreshService.load(Date.now());
  assert.deepEqual(reads, ["raw/2.md"], "foreground refresh still checks path, mtime and size even without a native event");
  assert.equal(refreshed.signals.find(signal => signal.id === 7)!.source.versions!["raw/2.md"], rawDigestFingerprint("raw/2.md", Buffer.from("未收到宿主事件，但stat的大小和修改时间已改变的资料")));
  reads.length = 0;
  await refresh.move("raw/3.md", "raw/renamed.md");
  refreshed = await refreshService.load(Date.now());
  assert.deepEqual(reads, ["raw/renamed.md"], "rename invalidates only the old/new path");
  assert.ok(refreshed.signals.find(signal => signal.id === 7)!.source.objects.includes("raw/renamed.md"));
  assert.ok(!refreshed.signals.find(signal => signal.id === 7)!.source.objects.includes("raw/3.md"));
  refreshService.dispose(); refresh.unregister();
  console.log("Workbench real data: disk-backed Todo/Finance/Raw/Review/English, journal templates/images/unknowns, Inbox observation/partial success/reload, full-Vault links and zero Provider calls passed");
}
