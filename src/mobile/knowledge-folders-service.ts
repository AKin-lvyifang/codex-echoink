import type { MobileKnowledgeFoldersPort, MobileKnowledgeFolderPreview, MobileKnowledgeFolderApplyResult } from "./knowledge-folders-contracts";
import type { MobileServices } from "./services";
import { emptyKnowledgeFolderBindings, knowledgeFolderIssues, knowledgeInboxRecallExclusions,
  normalizeKnowledgeFolderBindings, rebaseKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { previewKnowledgeDirectoryPlan, type KnowledgeDirectoryPlan } from "../knowledge-base/folder-plan";
import { rebaseKnowledgePath, KNOWLEDGE_ROOT_ROLES } from "../knowledge-base/root-paths-core";
import { optimizeWikiFolderNames } from "../knowledge-base/wiki-folder-names";
import { captureMoveLinks, finishMoveLinks } from "./knowledge-folders-links";
import { FolderJournal, type FolderTransaction, type FolderConfiguration, type FolderAction } from "./knowledge-folders-journal";
import { assertSavedBindings, digest, fileHash, inventory, kind, moduleDirectories, nativeJournalFolder, object, parentPath, protectedPaths, readBaseline, safePath, saveJournalFolder, settingsToken, stopped, within } from "./knowledge-folders-io";

interface PreparedFolders {
  preview: MobileKnowledgeFolderPreview; baseline: Awaited<ReturnType<typeof readBaseline>>;
  hashes: Record<string, string>; plan?: KnowledgeDirectoryPlan; original?: FolderTransaction;
}
const detail = (error: unknown): string => error instanceof Error ? error.message : "目录操作未完成，请重新核对。";

/** One mobile structural writer, using the existing domain rules and host rename API. */
export class MobileKnowledgeFoldersService implements MobileKnowledgeFoldersPort {
  private readonly journal: FolderJournal;
  private readonly previews = new Map<string, PreparedFolders>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly services: MobileServices) {
    this.journal = new FolderJournal(services.app.vault.adapter, `${services.directory}/knowledge-folders-v1`);
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action, action); this.queue = next.catch(() => undefined); return next;
  }
  private guard(signal?: AbortSignal): void {
    stopped(signal);
    if (this.services.settings.defaultPermission === "read-only") throw new Error("当前只读，未继续创建或移动目录文件。");
    if (this.services.settings.mobileUi.moduleEnabled?.["knowledge-base"] === false) throw new Error("知识库模块已停用。");
  }
  private configuration(): FolderConfiguration {
    const settings = this.services.settings, modules = moduleDirectories(this.services);
    return structuredClone({ bindings: settings.knowledgeBase.folderBindings ?? null, journal: settings.journalDirectory,
      review: settings.review.outputDir, english: settings.englishDiary.englishDirectory, expressions: settings.englishDiary.expressionDirectory,
      englishMode: settings.englishDiary.englishDirectoryMode, expressionMode: settings.englishDiary.expressionDirectoryMode,
      legacyEnglish: settings.englishDiary.legacyEnglishDirectories, legacyExpressions: settings.englishDiary.legacyExpressionDirectories,
      pdfOriginal: modules.pdfOriginal, nativeJournal: nativeJournalFolder(this.services) });
  }
  read: MobileKnowledgeFoldersPort["read"] = async () => {
    const baseline = await readBaseline(this.services), records = await this.journal.records();
    return { bindings: structuredClone(this.services.settings.knowledgeBase.folderBindings ?? null), token: baseline.token,
      directories: baseline.inventory.directories, writable: this.services.settings.defaultPermission !== "read-only",
      moduleDirectories: moduleDirectories(this.services), todoSourcePath: this.services.getTodoStore().sourcePath,
      todoSourceExists: (await this.services.app.vault.adapter.stat(this.services.getTodoStore().sourcePath))?.type === "file",
      restoreRecords: records.filter(record => record.kind !== "restore" && !record.restoredBy).map(record => ({ id: record.id,
        createdAt: record.createdAt, files: record.positions.length, status: record.status })).sort((a, b) => b.createdAt - a.createdAt) };
  };
  saveBindings: MobileKnowledgeFoldersPort["saveBindings"] = (next, token) => this.serial(async () => {
    if ((await readBaseline(this.services)).token !== token) throw new Error("目录或设置已变化，请重新读取后选择。");
    const previous = this.services.settings.knowledgeBase.folderBindings;
    const normalized = normalizeKnowledgeFolderBindings(next);
    if (!normalized) throw new Error("目录绑定无效。");
    for (const binding of Object.values(next.roles)) for (const path of [...binding.readPaths, ...binding.allowedSubdirectories, ...(binding.writePath ? [binding.writePath] : [])]) safePath(path);
    const oldIssues = new Set(previous ? knowledgeFolderIssues(previous) : []), issues = knowledgeFolderIssues(normalized).filter(issue => !oldIssues.has(issue));
    for (const role of KNOWLEDGE_ROOT_ROLES) {
      const binding = normalized.roles[role], before = previous?.roles[role];
      if (!binding.enabled || binding.native || digest(binding) === digest(before)) continue;
      for (const path of binding.readPaths) if (await kind(this.services.app.vault.adapter, path) !== "folder") issues.push(`原位置已失效：${path}`);
    }
    for (const source of ["web", "wechat"] as const) {
      const selected = normalized.collectionTargets?.[source], old = previous?.collectionTargets ? previous.collectionTargets[source] : previous?.roles.raw.writePath;
      const newlyEnabled = normalized.roles.raw.enabled && previous?.roles.raw.enabled !== true;
      if (selected && (selected !== old || newlyEnabled) && (!normalized.roles.raw.enabled || !normalized.roles.raw.readPaths.includes(selected)
        || await kind(this.services.app.vault.adapter, selected) !== "folder")) issues.push("收藏目的地只能选择已绑定的资料来源目录。");
    }
    if (issues.length) throw new Error(issues.join("；"));
    if ((await readBaseline(this.services)).token !== token) throw new Error("目录或设置已变化，请重新读取后选择。");
    normalized.inboxRecallExclusions = knowledgeInboxRecallExclusions(previous, normalized);
    normalized.configured = true; normalized.revision = (previous?.revision ?? 0) + 1;
    this.services.settings.knowledgeBase.folderBindings = normalized;
    try { await this.services.saveSettings(); await assertSavedBindings(this.services, normalized); }
    catch (error) { if (this.services.settings.knowledgeBase.folderBindings === normalized) this.services.settings.knowledgeBase.folderBindings = previous; throw error; }
    this.services.notifyHomeSurfacesChanged(); return this.read();
  });
  preview: MobileKnowledgeFoldersPort["preview"] = async (request, signal) => {
    stopped(signal);
    const input = structuredClone(request), baseline = await readBaseline(this.services), hashes: Record<string, string> = {};
    const preview: MobileKnowledgeFolderPreview = { token: "", request: input, reuse: [], create: [], moves: [], excluded: [], issues: [], changes: [] };
    const prepared: PreparedFolders = { preview, baseline, hashes };
    const adapter = this.services.app.vault.adapter;
    if (input.kind === "initialize") {
      input.createPaths.forEach(safePath);
      const plan = await previewKnowledgeDirectoryPlan({ baseRevision: this.services.settings.knowledgeBase.folderBindings?.revision ?? 0,
        baseline: this.services.settings.knowledgeBase.folderBindings, bindings: input.bindings, createPaths: input.createPaths, mode: input.mode,
        baseSettingsSignature: baseline.settings, moduleDirectories: input.moduleDirectories, files: baseline.inventory.files,
        protectedPaths: await protectedPaths(this.services, baseline.inventory, input.moduleDirectories),
        sourcePaths: baseline.inventory.files.filter(file => /\.(?:md|markdown)$/iu.test(file.path)).map(file => file.path), kind: path => kind(adapter, path) });
      prepared.plan = plan;
      Object.assign(preview, { reuse: plan.reuse, create: plan.create, moves: plan.moves.map(({ from, to }) => ({ from, to })), excluded: plan.excluded, issues: plan.issues, changes: plan.changes });
    } else if (input.kind === "names") {
      const bindings = this.services.settings.knowledgeBase.folderBindings;
      const allowed = new Set(Object.values(bindings?.roles ?? {}).flatMap(binding => binding.enabled ? binding.readPaths : []));
      if (!input.scopes.length || input.scopes.some(scope => !allowed.has(scope) || !baseline.inventory.directories.includes(scope))) throw new Error("请选择当前已绑定的目录范围。");
      input.scopes.forEach(safePath);
      const folders = baseline.inventory.directories.filter(path => input.scopes.some(scope => within(path, scope))).map(path => ({ path,
        titles: baseline.inventory.files.filter(file => parentPath(file.path) === path).map(file => file.path.slice(path.length + 1)) }));
      const paths = new Set([...baseline.inventory.directories, ...baseline.inventory.files.map(file => file.path)]);
      const names = await optimizeWikiFolderNames({ folders: () => folders, exists: path => paths.has(path), unsafeReason: () => null,
        assertActive: () => stopped(signal), generate: (system, user) => this.services.generateLifestyleText(system, user, 3000, signal ?? new AbortController().signal),
        rename: (from, to) => { paths.delete(from); paths.add(to); return Promise.resolve(); } });
      preview.moves = names.renamed; preview.excluded = names.skipped;
    } else {
      const original = await this.journal.read(input.recordId); prepared.original = original;
      if (original.kind === "restore" || original.restoredBy) preview.issues.push("该目录记录已完成复原或不是可复原记录。");
      if (original.status === "uncertain" || original.actions.some(action => action.state !== "completed")) preview.issues.push("原目录操作仍有未知结果，保留记录；不能自动重放或推测复原。");
      for (const position of [...original.positions].reverse()) {
        if (position.current === position.original || position.restored) continue;
        if (!await adapter.exists(position.current) || await fileHash(adapter, position.current) !== position.hash) {
          preview.excluded.push({ path: position.current, reason: "文件缺失或已被外部修改，保留现状。" }); continue;
        }
        if (await adapter.exists(position.original)) { preview.excluded.push({ path: position.original, reason: "原位置已占用，不会覆盖。" }); continue; }
        preview.moves.push({ from: position.current, to: position.original });
      }
      const directories = new Set<string>();
      for (const directory of original.directories ?? []) {
        if (await kind(adapter, directory.original) === "other") preview.excluded.push({ path: directory.original, reason: "原目录位置被文件占用，不会覆盖。" });
        else if (await kind(adapter, directory.original) === "missing") directories.add(directory.original);
      }
      for (const move of preview.moves) {
        let parent = parentPath(move.to);
        while (parent) { if (await kind(adapter, parent) === "missing") directories.add(parent); parent = parentPath(parent); }
      }
      preview.create = [...directories].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
      for (const [path, expected] of Object.entries(original.linkHashes)) if (await adapter.exists(path) && await fileHash(adapter, path) !== expected) {
        preview.issues.push(`原操作的链接文件已变化，请核对后再复原：${path}`);
      }
    }
    for (const move of preview.moves) {
      stopped(signal); safePath(move.from); safePath(move.to);
      if (within(move.to, move.from)) preview.issues.push(`目标不能位于源目录内：${move.to}`);
      for (const file of baseline.inventory.files.filter(file => within(file.path, move.from))) hashes[file.path] ??= await fileHash(adapter, file.path);
      const links = await captureMoveLinks(this.services.app, baseline.inventory, move.from, move.to);
      for (const link of links) hashes[link.path] ??= await fileHash(adapter, link.path);
    }
    stopped(signal);
    if ((await readBaseline(this.services)).token !== baseline.token) preview.issues.push("目录或设置已变化，请重新预览。");
    preview.issues = [...new Set(preview.issues)];
    preview.token = digest({ baseline: baseline.token, request: input, preview: { ...preview, token: "" }, hashes,
      record: prepared.original ? digest(prepared.original) : null });
    this.previews.set(preview.token, prepared);
    // Retain a small number of in-memory choices; nothing is persisted before confirmation.
    while (this.previews.size > 8) for (const oldest of this.previews.keys()) { this.previews.delete(oldest); break; }
    return structuredClone(preview);
  };
  apply: MobileKnowledgeFoldersPort["apply"] = (token, signal) => this.serial(async () => {
    const prepared = this.previews.get(token);
    if (!prepared) throw new Error("目录预览已失效或已使用，请重新预览后确认。");
    stopped(signal);
    const baseline = await readBaseline(this.services);
    let changed = baseline.token !== prepared.baseline.token;
    for (const [path, hash] of Object.entries(prepared.hashes)) if (!await this.services.app.vault.adapter.exists(path) || await fileHash(this.services.app.vault.adapter, path) !== hash) changed = true;
    if (prepared.original && digest(await this.journal.read(prepared.original.id)) !== digest(prepared.original)) changed = true;
    if (changed) { this.previews.delete(token); return { status: "reconfirm", preview: await this.preview(prepared.preview.request, signal) }; }
    if (prepared.preview.issues.length) throw new Error(prepared.preview.issues.join("；"));
    this.guard(signal);
    if ((await this.journal.records()).some(record => record.status === "uncertain")) throw new Error("目录操作有未知结果，请先核对已有记录；未重放移动。");
    this.previews.delete(token);
    return this.execute(prepared, signal);
  });
  private async installConfiguration(next: FolderConfiguration, signal?: AbortSignal): Promise<void> {
    this.guard(signal);
    const settings = this.services.settings;
    if (next.nativeJournal !== undefined && nativeJournalFolder(this.services) !== next.nativeJournal) await saveJournalFolder(this.services, next.nativeJournal, nativeJournalFolder(this.services), () => this.guard(signal));
    this.guard(signal);
    settings.knowledgeBase.folderBindings = structuredClone(next.bindings);
    settings.journalDirectory = next.journal; settings.review.outputDir = next.review;
    settings.englishDiary.englishDirectory = next.english; settings.englishDiary.expressionDirectory = next.expressions;
    settings.englishDiary.englishDirectoryMode = next.englishMode; settings.englishDiary.expressionDirectoryMode = next.expressionMode;
    settings.englishDiary.legacyEnglishDirectories = next.legacyEnglish; settings.englishDiary.legacyExpressionDirectories = next.legacyExpressions;
    const pdf = object(settings.pdfReading);
    if (next.pdfOriginal === undefined) { if (pdf.originalDirectory !== undefined) { const updated = { ...pdf }; delete updated.originalDirectory; settings.pdfReading = updated; } }
    else settings.pdfReading = { ...pdf, originalDirectory: next.pdfOriginal };
    this.guard(signal); await this.services.saveSettings(); await assertSavedBindings(this.services, next.bindings);
    const observed = this.configuration();
    if (digest(observed) !== digest(next)) {
      const changed = Object.keys(next).filter(key => digest(object(observed)[key]) !== digest(object(next)[key]));
      throw new Error(`目录配置保存回读不一致：${changed.join("、")}`);
    }
  }
  private intendedConfiguration(prepared: PreparedFolders, before: FolderConfiguration): FolderConfiguration {
    const next = structuredClone(before), request = prepared.preview.request;
    if (prepared.plan) {
      next.bindings = { ...structuredClone(prepared.plan.bindings), configured: true, revision: prepared.plan.baseRevision + 1 };
      const modules = prepared.plan.moduleDirectories;
      if (modules?.journal !== undefined) { next.journal = modules.journal; next.nativeJournal = modules.journal; }
      if (modules?.review !== undefined) next.review = modules.review;
      if (modules?.english !== undefined) { if (next.english !== modules.english) next.legacyEnglish = [...new Set([...(next.legacyEnglish ?? []), next.english])]; next.english = modules.english; next.englishMode = "custom"; }
      if (modules?.expressions !== undefined) { if (next.expressions !== modules.expressions) next.legacyExpressions = [...new Set([...(next.legacyExpressions ?? []), next.expressions])]; next.expressions = modules.expressions; next.expressionMode = "custom"; }
      if (modules?.pdfOriginal !== undefined) next.pdfOriginal = modules.pdfOriginal;
    } else if (request.kind === "names") {
      for (const move of prepared.preview.moves) {
        if (next.bindings) next.bindings = rebaseKnowledgeFolderBindings(next.bindings, move.from, move.to);
        for (const key of ["journal", "nativeJournal", "review", "english", "expressions", "pdfOriginal"] as const) { const path = next[key]; if (path !== undefined) next[key] = rebaseKnowledgePath(path, move.from, move.to); }
        next.legacyEnglish = next.legacyEnglish?.map(path => rebaseKnowledgePath(path, move.from, move.to));
        next.legacyExpressions = next.legacyExpressions?.map(path => rebaseKnowledgePath(path, move.from, move.to));
      }
    } else if (prepared.original?.after) {
      const original = prepared.original, applied = original.after!;
      const config = structuredClone(before.bindings ?? emptyKnowledgeFolderBindings());
      for (const role of KNOWLEDGE_ROOT_ROLES) if (digest(before.bindings?.roles[role]) === digest(applied.bindings?.roles[role])) {
        const prior = original.before.bindings?.roles[role] ?? emptyKnowledgeFolderBindings().roles[role];
        const current = config.roles[role];
        const retained = current.readPaths.filter(root => prepared.baseline.inventory.files.some(file => within(file.path, root)
          && !prepared.preview.moves.some(move => move.from === file.path)));
        config.roles[role] = structuredClone(prior);
        if (retained.length) {
          const restored = config.roles[role]; restored.enabled = true; restored.readPaths = [...new Set([...restored.readPaths, ...retained])];
          restored.writePath ??= current.writePath; restored.compatibilityReadScopes = restored.readPaths.length > 1;
          restored.autoOrganizePaths = [...new Set([...(restored.autoOrganizePaths ?? []), ...(current.autoOrganizePaths ?? []).filter(path => retained.includes(path))])];
          restored.allowedSubdirectoryRoots = [...new Set([...(restored.allowedSubdirectoryRoots ?? prior.readPaths), ...(current.allowedSubdirectoryRoots ?? current.readPaths).filter(path => retained.includes(path))])];
          restored.allowedSubdirectories = [...new Set([...prior.allowedSubdirectories, ...current.allowedSubdirectories])];
        }
      }
      if (digest(before.bindings?.collectionTargets) === digest(applied.bindings?.collectionTargets)) config.collectionTargets = structuredClone(original.before.bindings?.collectionTargets);
      config.revision = (before.bindings?.revision ?? 0) + 1; next.bindings = config;
      for (const key of ["journal", "nativeJournal", "review", "english", "expressions", "englishMode", "expressionMode", "legacyEnglish", "legacyExpressions", "pdfOriginal"] as const) {
        const current = before[key], directory = typeof current === "string" && ["journal", "nativeJournal", "review", "english", "expressions", "pdfOriginal"].includes(key) ? current : null;
        const retained = directory && prepared.baseline.inventory.files.some(file => within(file.path, directory) && !prepared.preview.moves.some(move => move.from === file.path));
        if (!retained && digest(current) === digest(applied[key])) Object.assign(next, { [key]: structuredClone(original.before[key]) });
      }
    }
    return next;
  }
  private async execute(prepared: PreparedFolders, signal?: AbortSignal): Promise<MobileKnowledgeFolderApplyResult> {
    const adapter = this.services.app.vault.adapter, before = this.configuration(), expected = { ...prepared.hashes };
    const transaction: FolderTransaction = { schema: 1, id: `folders-${Date.now().toString(36)}-${crypto.randomUUID()}`, createdAt: Date.now(),
      kind: prepared.preview.request.kind, status: "partial", before, positions: [], actions: [], created: [], linkHashes: {},
      directories: prepared.baseline.inventory.directories.filter(path => prepared.preview.moves.some(move => within(path, move.from))).map(path => ({ original: path, current: path })),
      ...(prepared.original ? { restoreOf: prepared.original.id } : {}) };
    for (const file of prepared.baseline.inventory.files) if (prepared.preview.moves.some(move => within(file.path, move.from))) transaction.positions.push({ original: file.path, current: file.path, hash: expected[file.path] });
    const result: Exclude<MobileKnowledgeFolderApplyResult, { status: "reconfirm" }> = { status: "partial", recordId: transaction.id, created: [], moved: [], issues: [] };
    let active: FolderAction | undefined, liveSettings = prepared.baseline.settings;
    const guard = () => this.guard(signal);
    const assertSettings = async () => { if (await settingsToken(this.services) !== liveSettings) throw new Error("目录操作期间设置已变化，停止后续写入。"); };
    try {
      guard(); await this.journal.write(transaction);
      for (const directory of prepared.preview.create) {
        guard(); await assertSettings();
        if (await kind(adapter, directory) !== "missing") throw new Error(`目录位置已被占用：${directory}`);
        active = { kind: "mkdir", to: directory, state: "prepared" }; transaction.actions.push(active); await this.journal.write(transaction);
        guard(); await this.services.app.vault.createFolder(directory);
        if (await kind(adapter, directory) !== "folder") throw new Error(`目录创建回读未确认：${directory}`);
        active.state = "completed"; transaction.created.push(directory); result.created.push(directory); await this.journal.write(transaction); active = undefined;
      }
      for (const move of prepared.preview.moves) {
        guard(); await assertSettings();
        const current = await inventory(this.services), affected = current.files.filter(file => within(file.path, move.from));
        if (!affected.length && await kind(adapter, move.from) !== "folder") throw new Error(`源位置不存在：${move.from}`);
        for (const file of affected) if (!expected[file.path] || await fileHash(adapter, file.path) !== expected[file.path]) throw new Error(`源文件已变化：${file.path}`);
        if (await adapter.exists(move.to)) throw new Error(`目标位置已占用，未覆盖：${move.to}`);
        const links = await captureMoveLinks(this.services.app, current, move.from, move.to);
        for (const link of links) if (!expected[link.path] || await fileHash(adapter, link.path) !== expected[link.path]) throw new Error(`链接文件已变化，请重新核对：${link.path}`);
        const file = this.services.app.vault.getAbstractFileByPath(move.from);
        if (!file) throw new Error(`宿主尚未读到源路径：${move.from}`);
        active = { kind: "move", from: move.from, to: move.to, state: "prepared" }; transaction.actions.push(active); await this.journal.write(transaction);
        guard();
        for (const item of affected) if (await fileHash(adapter, item.path) !== expected[item.path]) throw new Error(`移动前源文件已变化：${item.path}`);
        if (await adapter.exists(move.to)) throw new Error(`目标位置已占用，未覆盖：${move.to}`);
        guard();
        await this.services.app.fileManager.renameFile(file, move.to);
        if (await adapter.exists(move.from) || !await adapter.exists(move.to)) throw new Error(`目录移动结果未知：${move.from}`);
        await finishMoveLinks(this.services.app, links, await inventory(this.services), guard);
        const linked = new Set(links.map(link => link.nextPath));
        for (const item of affected) {
          const target = rebaseKnowledgePath(item.path, move.from, move.to), hash = await fileHash(adapter, target);
          if (!linked.has(target) && hash !== expected[item.path]) throw new Error(`移动后文件字节未核实：${target}`);
        }
        for (const [path, hash] of Object.entries({ ...expected })) if (within(path, move.from)) { delete expected[path]; expected[rebaseKnowledgePath(path, move.from, move.to)] = hash; }
        for (const link of links) expected[link.nextPath] = await fileHash(adapter, link.nextPath);
        for (const position of transaction.positions) { position.current = rebaseKnowledgePath(position.current, move.from, move.to); position.hash = expected[position.current]; }
        for (const directory of transaction.directories ?? []) directory.current = rebaseKnowledgePath(directory.current, move.from, move.to);
        transaction.linkHashes = Object.fromEntries(Object.entries(transaction.linkHashes).map(([path, hash]) => [rebaseKnowledgePath(path, move.from, move.to), hash]));
        for (const link of links) transaction.linkHashes[link.nextPath] = expected[link.nextPath];
        active.state = "completed"; result.moved.push(move); await this.journal.write(transaction); active = undefined;
      }
      guard(); await assertSettings();
      transaction.after = this.intendedConfiguration(prepared, before);
      active = { kind: "settings", state: "prepared" }; transaction.actions.push(active); await this.journal.write(transaction);
      guard(); await this.installConfiguration(transaction.after, signal);
      liveSettings = await settingsToken(this.services); active.state = "completed"; transaction.status = "completed";
      await this.journal.write(transaction); active = undefined;
      if (prepared.original) {
        const original = await this.journal.read(prepared.original.id);
        for (const move of result.moved) for (const position of original.positions) if (position.current === move.from && position.original === move.to) { position.current = move.to; position.hash = await fileHash(adapter, move.to); position.restored = true; }
        if (original.positions.every(position => position.current === position.original || position.restored)) original.restoredBy = transaction.id;
        await this.journal.write(original);
      }
      this.services.notifyHomeSurfacesChanged();
      if (prepared.original && prepared.preview.excluded.length) { result.status = "partial"; result.issues.push(...prepared.preview.excluded); }
      else result.status = "completed";
      return result;
    } catch (error) {
      if (active) { active.state = "uncertain"; transaction.status = "uncertain"; } else transaction.status = "partial";
      result.status = transaction.status; result.issues.push({ path: active?.from ?? active?.to ?? "目录配置", reason: detail(error) });
      try { await this.journal.write(transaction); } catch (receiptError) { result.status = "uncertain"; result.issues.push({ path: transaction.id, reason: `回执未完整保存：${detail(receiptError)}` }); }
      return result;
    }
  }
}
