import assert from "node:assert/strict";
import path from "node:path";
import type { App } from "obsidian";
import { projectedKnowledgeLinks } from "../knowledge-base/knowledge-link-resolution";
import { captureKnowledgeMoveLinks } from "../knowledge-base/knowledge-move-links";
import {
  executeKnowledgeSystemMove,
  type KnowledgeSystemMovePlan,
  type KnowledgeSystemMoveProgress,
} from "../knowledge-base/knowledge-system-move";
import {
  knowledgeSystemHash,
  KnowledgeSystemTaskService,
} from "../knowledge-base/knowledge-system-task";
import { rebaseKnowledgePathRecords } from "../knowledge-base/root-paths-core";
import { rebaseKnowledgeLinkingMove } from "../knowledge-base/knowledge-linking-state";
import type { KnowledgeLinkingTask } from "../knowledge-base/knowledge-linking-types";

export async function runKnowledgeSystemMoveTests(): Promise<void> {
  const a = "Wiki/A/a.md",
    b = "Wiki/B/b.md",
    inbound = "Refs/入链.md",
    outbound = "Refs/出链.md";
  const files = new Map([
    [
      a,
      '---\nrelated: "[[../B/b#标题|属性显示名]]"\ncustom: 0021 # 保留\n---\n[读物](../../Refs/出链.md#标题 "原显示名")\n![[../B/b#^block|嵌入名]]\n[[#^local]]\n',
    ],
    [b, "# 标题\n内容 ^block\n"],
    [
      inbound,
      '---\nlinks: ["[[../Wiki/A/a#^local|属性入链]]"]\n---\n[入链](../Wiki/A/a.md#^local "保留标题")\n[[Wiki/A/a#标题|保留显示名]]\n',
    ],
    [outbound, "# 标题\n外部条目。\n"],
  ]);
  const metadata = (content: string) => {
    const end = content.startsWith("---\n") ? content.indexOf("\n---\n", 4) + 5 : 0;
    const wiki = [...content.matchAll(/!?\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/gu)];
    const md = [...content.matchAll(/\[[^\]]*\]\(([^ )]+)(?: "[^"]*")?\)/gu)];
    const ref = (match: RegExpMatchArray) => ({
      original: match[0],
      link: match[1],
      position: {
        start: { offset: match.index! },
        end: { offset: match.index! + match[0].length },
      },
    });
    return {
      links: [...wiki, ...md].filter((match) => match.index! >= end).map(ref),
      frontmatterLinks: wiki.filter((match) => match.index! < end).map(ref),
    };
  };
  const app = {
    vault: {
      getFiles: () => [...files.keys()].map((path) => ({ path })),
      getMarkdownFiles: () => [...files.keys()].map((path) => ({ path })),
      read: async (file: { path: string }) => files.get(file.path),
      getFileByPath: (path: string) => (files.has(path) ? { path } : null),
    },
    metadataCache: {
      getFileCache: (file: { path: string }) => metadata(files.get(file.path)!),
      getFirstLinkpathDest: (raw: string, source: string) => {
        const link = decodeURIComponent(raw);
        for (const candidate of [
          link,
          path.posix.normalize(path.posix.join(path.posix.dirname(source), link)),
        ]) {
          const found = files.has(candidate)
            ? candidate
            : files.has(candidate + ".md")
              ? candidate + ".md"
              : null;
          if (found) return { path: found };
        }
        return null;
      },
    },
  } as unknown as App;
  await shortLinkAndReadBudgetTests();
  const moves = [
    { from: a, to: "Wiki/领域/分支/a.md", revision: knowledgeSystemHash(files.get(a)!) },
    { from: b, to: "Wiki/领域/分支/b.md", revision: knowledgeSystemHash(files.get(b)!) },
  ];
  const links = await captureKnowledgeMoveLinks(app, moves);
  const movedNote = links.find((patch) => patch.sourcePath === a)!;
  assert.match(movedNote.after, /Wiki\/领域\/分支\/b#标题\|属性显示名/u);
  assert.match(
    movedNote.after,
    /\.\.\/\.\.\/\.\.\/Refs\//u,
    "Relative outbound follows the new source directory",
  );
  assert.match(movedNote.after, /#标题 "原显示名"/u);
  assert.ok(movedNote.after.includes("#^block|嵌入名"));
  assert.ok(movedNote.after.includes("[[#^local]]"));
  assert.ok(movedNote.after.includes("custom: 0021 # 保留"));
  const incoming = links.find((patch) => patch.sourcePath === inbound)!;
  assert.ok(incoming.after.includes("#^local|属性入链"));
  assert.ok(incoming.after.includes('#^local "保留标题"'));
  assert.ok(incoming.after.includes("Wiki/领域/分支/a#标题|保留显示名"));
  assert.equal(files.get(a), movedNote.before, "Preview never writes source files");

  const disk = new Map([
    ["old/a.md", "a"],
    ["old/b.md", "b"],
    ["ref.md", "before"],
  ]);
  const plan: KnowledgeSystemMovePlan = {
    files: ["a", "b"].map((name) => ({
      from: `old/${name}.md`,
      to: `new/${name}.md`,
      revision: knowledgeSystemHash(name),
    })),
    links: [{ sourcePath: "ref.md", path: "ref.md", before: "before", after: "after" }],
    beforeMapBlock: null,
    afterBlock: "map",
    operations: [],
    digest: "bound",
  };
  let progress: KnowledgeSystemMoveProgress = { moved: [], linked: [] },
    durable = structuredClone(progress);
  let renames = 0,
    writes = 0,
    recovered = 0,
    scans = 0,
    crashRename = true,
    crashLinks = true;
  const host = {
    read: async (path: string) => disk.get(path) ?? null,
    rename: async (from: string, to: string) => {
      renames++;
      disk.set(to, disk.get(from)!);
      disk.delete(from);
      if (crashRename) {
        crashRename = false;
        disk.set(to, "native changed content while renaming");
        throw new Error("interruption after rename, before checkpoint");
      }
    },
    syncPaths: async () => {
      recovered++;
    },
    writeLinks: async () => {
      writes++;
      disk.set("ref.md", "after");
      if (crashLinks) {
        crashLinks = false;
        throw new Error("interruption after link write");
      }
    },
    pauseLinking: async () => {},
    rescanLinking: async () => {
      scans++;
    },
  };
  const checkpoint = async () => {
    durable = structuredClone(progress);
  };
  await assert.rejects(
    executeKnowledgeSystemMove(plan, progress, host, checkpoint, new AbortController().signal),
    /after rename/u,
  );
  progress = structuredClone(durable);
  await assert.rejects(
    executeKnowledgeSystemMove(plan, progress, host, checkpoint, new AbortController().signal),
    /link write/u,
  );
  progress = structuredClone(durable);
  await executeKnowledgeSystemMove(plan, progress, host, checkpoint, new AbortController().signal);
  assert.equal(renames, 2, "Cold recovery never repeats completed renames");
  assert.equal(
    recovered,
    1,
    "Effect-started rename is recovered by endpoint readback even when content differs",
  );
  assert.equal(writes, 1, "A written link patch is read back, not written again");
  assert.equal(scans, 1);
  assert.equal(progress.moved.length, 2);
  assert.equal(progress.linked.length, 1);

  const pending = { pendingLinking: { targetPaths: [a], sourcePaths: [b] }, text: a };
  assert.equal(
    rebaseKnowledgePathRecords(pending, a, moves[0].to).pendingLinking.targetPaths[0],
    moves[0].to,
  );
  assert.equal(rebaseKnowledgePathRecords(pending, a, moves[0].to).text, a);
  const stale = {
    schemaVersion: 1,
    id: "links",
    phase: "awaiting-confirmation",
    mode: "manual",
    writeConfirmed: true,
    proposals: [{ path: a }],
    patches: [{ path: a }],
    results: [],
    sourcePaths: [a],
    targetPaths: [b],
    queuedAutomatic: [{ id: "queued", paths: [a], sourcePaths: [b], at: 1 }],
  } as unknown as KnowledgeLinkingTask;
  const invalidated = rebaseKnowledgeLinkingMove(stale, moves);
  assert.equal(invalidated.patches.length, 0);
  assert.equal(invalidated.proposals.length, 0);
  assert.equal(invalidated.writeConfirmed, false);
  assert.deepEqual(invalidated.targetPaths, [moves[1].to]);
  assert.deepEqual(invalidated.queuedAutomatic![0].paths, [moves[0].to]);
  assert.equal(invalidated.phase, "interrupted");
  await confirmationScopeTests();
  console.log(
    "Knowledge system move: complete links, separate rename/link recovery, operation binding, maintenance gate and path invalidation passed.",
  );
}

async function confirmationScopeTests(): Promise<void> {
  for (const move of [false, true]) {
    const disk = new Map([
      ["wiki/a.md", "全文"],
      ["wiki/index.md", ""],
    ]);
    let effects = 0,
      blocked = true;
    const movePlan: KnowledgeSystemMovePlan = {
      files: [{ from: "wiki/a.md", to: "wiki/A/分支/a.md", revision: knowledgeSystemHash("全文") }],
      links: [],
      beforeMapBlock: null,
      afterBlock:
        "<!-- echoink-domain-map:BEGIN A -->\n<!-- echoink-domain-map:MODE tree -->\n## A\n### 分支\n- [[wiki/A/分支/a.md]]\n<!-- echoink-domain-map:END A -->",
      operations: [
        {
          kind: "move",
          from: "wiki/a.md",
          to: "wiki/A/分支/a.md",
          before: knowledgeSystemHash("全文"),
        },
      ],
      digest: "move-scope",
    };
    const service = new KnowledgeSystemTaskService({
      vaultRoot: "move-confirmation",
      load: async () => [],
      save: async () => {},
      discover: async () => ({
        documents: [{ path: "wiki/a.md", content: "全文", revision: knowledgeSystemHash("全文") }],
        mapPath: "wiki/index.md",
        block: null,
        bindingRevision: 1,
        declined: [],
      }),
      createConversation: async () => "move-session",
      assertAccess: async () => {},
      read: async (path) => disk.get(path) ?? null,
      write: async (task) => {
        disk.set(task.write!.path, task.write!.after);
      },
      changed: () => {},
      planMove: async () => movePlan,
      checkMove: async () => (blocked ? { title: "未完成维护", conversationId: "maintain" } : null),
      move: async (task, signal, checkpoint) => {
        task.moveProgress ??= { moved: [], linked: [] };
        await executeKnowledgeSystemMove(
          movePlan,
          task.moveProgress,
          {
            read: async (path) => disk.get(path) ?? null,
            rename: async (from, to) => {
              effects++;
              disk.set(to, disk.get(from)!);
              disk.delete(from);
            },
            syncPaths: async () => {},
            writeLinks: async () => {},
            pauseLinking: async () => {},
            rescanLinking: async () => {},
          },
          checkpoint,
          signal,
        );
      },
    });
    const { task } = await service.start("A", "keeper");
    await service.readNext(task.conversationId);
    await service.propose(task.conversationId, {
      domain: "A",
      frameworks: ["时序", "能力"].map((title) => ({
        title,
        rationale: "按全文",
        branches: [
          { title: "分支", rationale: "有依据", entries: [{ path: "wiki/a.md", why: "全文依据" }] },
        ],
        unplaced: [],
        gaps: [],
      })),
    });
    const binding = service.confirmation(task, 0, move);
    assert.notEqual(
      service.confirmation(task, 0, true).operationsDigest,
      service.confirmation(task, 0, false).operationsDigest,
    );
    await service.confirm(binding);
    if (move) {
      assert.equal(task.phase, "awaiting-confirmation");
      assert.equal(effects, 0);
      assert.equal(disk.get("wiki/index.md"), "");
      assert.match(task.error!, /继续或结束/u);
      blocked = false;
      await service.confirm(binding);
      assert.equal(effects, 1);
      assert.ok(disk.has("wiki/A/分支/a.md"));
    } else {
      assert.equal(effects, 0);
      assert.ok(disk.has("wiki/a.md"));
    }
    assert.equal(task.phase, "completed");
    if (move) assert.match(task.receipt!, /搬了 1 篇/u);
    else assert.ok(!task.receipt!.includes("搬了"));
  }
}

async function shortLinkAndReadBudgetTests(): Promise<void> {
  const from = "Wiki/领域/短名.md",
    to = "Wiki/领域/分支/短名.md";
  const source = "Wiki/领域/入口.md",
    nextSource = "Wiki/领域/另组/入口.md";
  const duplicate = "别处/短名.md",
    fixed = "资料/未搬.md";
  const moves = new Map([
    [from, to],
    [source, nextSource],
  ]);
  const paths = [from, source, duplicate, fixed];
  const resolve = projectedKnowledgeLinks(paths, moves);
  assert.equal(
    resolve("短名", nextSource),
    duplicate,
    "A closer same-name file steals the short link",
  );
  assert.equal(resolve("资料/未搬.md", nextSource), fixed);
  const bodies = new Map([
    [from, "# 验收标题\n内容 ^block\n"],
    [
      source,
      "[[短名]]\n[[短名#验收标题]]\n[[短名#^block]]\n![[短名]]\n[[短名|显示名]]\n[[资料/未搬.md#标题|x]]\n",
    ],
    [duplicate, "同名笔记"],
    [fixed, "未搬的资料"],
  ]);
  for (let index = 0; index < 10000; index++) bodies.set(`大库/${index}.md`, "独立正文");
  let reads = 0;
  const app = {
    vault: {
      getFiles: () => [...bodies.keys()].map((path) => ({ path })),
      getMarkdownFiles: () => [...bodies.keys()].map((path) => ({ path })),
      getFileByPath: (path: string) => (bodies.has(path) ? { path } : null),
      read: async (file: { path: string }) => {
        reads++;
        return bodies.get(file.path);
      },
    },
    metadataCache: {
      getFileCache: (file: { path: string }) => ({
        links: [...bodies.get(file.path)!.matchAll(/!?\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/gu)].map(
          (match) => ({
            original: match[0],
            link: match[1],
            position: {
              start: { offset: match.index! },
              end: { offset: match.index! + match[0].length },
            },
          }),
        ),
      }),
      getFirstLinkpathDest: (link: string, current: string) => {
        const found = projectedKnowledgeLinks(paths, new Map())(link, current);
        return found ? { path: found } : null;
      },
    },
  } as unknown as App;
  const plans = await captureKnowledgeMoveLinks(
    app,
    [...moves].map(([from, to]) => ({ from, to, revision: "test" })),
  );
  const content = plans.find((p) => p.sourcePath === source)!.after;
  assert.ok(content.includes(`[[${to.slice(0, -3)}|短名]]`));
  assert.ok(content.includes("#验收标题|短名 > 验收标题"));
  assert.ok(content.includes("#^block|短名 > ^block"));
  assert.ok(content.includes(`![[${to.slice(0, -3)}|短名]]`));
  assert.ok(content.includes(`[[${to.slice(0, -3)}|显示名]]`));
  assert.ok(
    content.includes("[[资料/未搬.md#标题|x]]"),
    "Valid outbound spelling stays byte exact",
  );
  assert.equal(
    reads,
    1,
    "Only the note with affected references is read, even with ten thousand notes",
  );
  bodies.delete(duplicate);
  paths.splice(paths.indexOf(duplicate), 1);
  reads = 0;
  assert.equal(
    (
      await captureKnowledgeMoveLinks(
        app,
        [...moves].map(([from, to]) => ({ from, to, revision: "test" })),
      )
    ).length,
    0,
  );
  assert.equal(
    reads,
    0,
    "Valid short links and moved notes with stable references need no body reads",
  );
}
